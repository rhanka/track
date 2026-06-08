import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname } from 'node:path'

/**
 * Cross-process write serialization for the single-stream event log.
 *
 * `EventStore.appendCommand` runs read → validate → compute (prevHash/seq) → append → writeHead as a
 * critical section with NO mutual exclusion. Two writers on the same `events.jsonl` (a CLI run while an
 * MCP server is live, two `track-mcp` instances, an h2a sidecar) both read the same N-event prefix,
 * compute the SAME `prevHash`/`seq`, and append — producing a broken `prevHash` chain + duplicate `seq`
 * + a stale `head.json`. The fail-closed guard then refuses EVERY future append (a permanent, human-only
 * repair): an integrity-DoS triggerable by any concurrent writer. `withFileLock` serializes that section
 * across processes so the single-writer contract holds in practice, not just in intent.
 *
 * DELIBERATELY NO automatic stale-lock stealing (review verdict, Lot v2.3b-0): pathname-based stealing
 * is intrinsically racy — two waiters can both judge a lock abandoned, the slower `unlink` then deletes
 * the WINNER's fresh lock and mutual exclusion is broken; and an age-based steal can preempt a merely
 * SLOW live holder (large log, slow disk, SIGSTOP/suspend), putting two writers in the critical section.
 * Both failure modes recreate the exact corruption this lock exists to prevent. Posture instead:
 * fail-closed with a DIAGNOSED timeout — the error reports the holder PID and whether it is still
 * running, so a human can safely remove an orphaned lock (the only way one arises is a writer dying
 * mid-append, e.g. SIGKILL/power loss; appends take milliseconds). This matches the store's existing
 * fail-closed stance (a torn trailing line is also detected, never silently repaired).
 *
 * Scope: same-host writers only (advisory `O_EXCL` lockfile + local PID diagnosis). Shared/networked
 * filesystems (NFS) are out of scope, as is the store itself (single host, single writer — SPEC).
 * Operational only — it does NOT touch the frozen event contract (stream/seq/prevHash/hash).
 * Upgrade path: `flock(2)` on a held fd would auto-release on process death (no orphan, no manual rm),
 * but Node's stdlib does not expose it — adopt only if a native dep ever becomes acceptable.
 */
export interface LockOptions {
  /** Max time to wait to acquire before throwing (never hang). */
  timeoutMs?: number
  /** Poll interval while contended. */
  retryMs?: number
}

const DEFAULTS: Required<LockOptions> = { timeoutMs: 10_000, retryMs: 20 }

interface Holder {
  pid: number
  host: string
  time: number
  /** Unique per-acquisition token — release deletes ONLY its own generation. */
  token: string
}

/** Synchronous sleep — the store is fully synchronous. Blocks the thread without burning CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms))
}

/** Is `pid` a live process on THIS host? ESRCH ⇒ dead; EPERM ⇒ alive but not ours to signal. */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readHolder(lockPath: string): Holder | undefined {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')) as Holder
  } catch {
    return undefined // missing, torn, or empty — caller decides what that means
  }
}

/** Human-actionable diagnosis for a timeout: who holds it, and is removing it safe? */
function diagnose(lockPath: string): string {
  const holder = readHolder(lockPath)
  if (holder === undefined) {
    return 'holder record unreadable (lock vanished or torn)'
  }
  const liveness = isAlive(holder.pid)
    ? 'still RUNNING — another track writer is active, do not remove'
    : 'NOT running — orphaned (writer died mid-append); safe to delete the lock file to recover'
  return `held by pid ${holder.pid}@${holder.host} since ${new Date(holder.time).toISOString()}, ${liveness}`
}

/**
 * Run `fn` while holding an exclusive cross-process lock on `<targetPath>.lock`. Released in `finally`
 * (only its own generation — a token mismatch means the lock is no longer ours and is left alone).
 * Throws a diagnosed error after `timeoutMs` rather than hanging or stealing. NOT reentrant (the store
 * never nests appends). NOTE: the store is synchronous, so a contended acquire blocks the whole event
 * loop for up to `timeoutMs` — acceptable for the CLI and the (serial) stdio MCP server.
 */
export function withFileLock<T>(targetPath: string, fn: () => T, options: LockOptions = {}): T {
  const { timeoutMs, retryMs } = { ...DEFAULTS, ...options }
  const lockPath = `${targetPath}.lock`
  mkdirSync(dirname(lockPath), { recursive: true })
  const token = randomBytes(12).toString('hex')
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx') // O_CREAT|O_EXCL|O_WRONLY — fails with EEXIST if held
      try {
        const holder: Holder = { pid: process.pid, host: hostname(), time: Date.now(), token }
        writeSync(fd, JSON.stringify(holder))
      } finally {
        closeSync(fd)
      }
      break // acquired
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (Date.now() >= deadline) {
        throw new Error(
          `withFileLock: timed out after ${timeoutMs}ms waiting for ${lockPath} — ${diagnose(lockPath)}.`,
        )
      }
      sleepSync(retryMs)
    }
  }

  try {
    return fn()
  } finally {
    // Release ONLY our own generation. If the file no longer carries our token (e.g. a human removed an
    // orphan and another writer acquired), deleting it would break THEIR mutual exclusion — leave it.
    if (readHolder(lockPath)?.token === token) {
      try {
        unlinkSync(lockPath)
      } catch {
        // already gone — nothing to release
      }
    }
  }
}
