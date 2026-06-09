import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { canonicalize, materialize } from './canonical.js'
import { contentHashOf } from './frame.js'
import { readHead, writeHead } from './head.js'
import { withFileLock, type LockOptions } from './lock.js'
import type { CommandEvent, EventCore, Sha256, TrackEvent, Ulid } from './types.js'
import { validate } from './validate.js'

/**
 * Operational-only lock timeout override (`TRACK_LOCK_TIMEOUT_MS`). Lets a caller cap how long a
 * contended append waits before failing loud — used by tests and by anyone who prefers a fast fail
 * over the 10s default. It does NOT touch the frozen event contract (no event shape/hash/seq change),
 * only how long `withFileLock` blocks. An invalid/absent value falls back to the lock's own default.
 */
function lockOptionsFromEnv(): LockOptions {
  const raw = process.env['TRACK_LOCK_TIMEOUT_MS']
  if (raw === undefined) return {}
  const ms = Number(raw)
  return Number.isFinite(ms) && ms > 0 ? { timeoutMs: ms } : {}
}

/**
 * Append-only single-writer event store over `.track/events.jsonl` (SPEC §3, §4).
 * The store owns the integrity frame: it assigns per-aggregate `seq`, the positional
 * `prevHash`, and `contentHash`, and writes a command's events as one atomic batch.
 *
 * Fail-closed: `appendCommand` `validate`s the existing log before extending it, so a
 * tampered/reordered/truncated log cannot be silently grown.
 */
export class EventStore {
  constructor(private readonly filePath: string) {}

  /** All events in stream (append) order. Throws on a malformed (e.g. torn) line. */
  readAll(): TrackEvent[] {
    if (!existsSync(this.filePath)) return []
    const raw = readFileSync(this.filePath, 'utf8')
    const events: TrackEvent[] = []
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === undefined || line.trim().length === 0) continue
      try {
        events.push(JSON.parse(line) as TrackEvent)
      } catch {
        throw new Error(`EventStore: malformed event line ${i + 1} in ${this.filePath}`)
      }
    }
    return events
  }

  /**
   * Append one command's events atomically. A multi-event command (`inputs.length > 1`)
   * requires `opts.cmdId` and is tagged with `cmd:{i,n}`; a single-event command is
   * standalone (no `cmdId`). Refuses to extend a log that does not pass `validate`.
   */
  appendCommand(
    inputs: ReadonlyArray<CommandEvent>,
    opts: { cmdId?: Ulid } = {},
  ): TrackEvent[] {
    if (inputs.length === 0) {
      throw new Error('EventStore.appendCommand: empty command (no events)')
    }
    const n = inputs.length
    const isBatch = n > 1
    if (isBatch && opts.cmdId === undefined) {
      throw new Error('EventStore.appendCommand: a multi-event command requires a cmdId')
    }

    // Serialize the read→validate→compute→append→writeHead critical section ACROSS processes. Without
    // it, two concurrent writers compute the same prevHash/seq and corrupt the single stream, which the
    // fail-closed guard below then turns into a permanent write-DoS for every future writer (see lock.ts).
    return withFileLock(this.filePath, () => {
      const existing = this.readAll()
      const before = existing.length
      const integrity = validate(existing, readHead(this.filePath))
      if (!integrity.ok) {
        const kinds = integrity.findings.map((f) => f.kind).join(', ')
        throw new Error(
          `EventStore.appendCommand: refusing to extend an invalid log ` +
            `(${integrity.findings.length} finding(s): ${kinds})`,
        )
      }

      let prevHash: Sha256 | null =
        existing.length > 0 ? existing[existing.length - 1]!.contentHash : null

      // Next per-aggregate seq = max(seq) + 1, aligned with validate's authority.
      const lastSeqByAggregate = new Map<string, number>()
      for (const e of existing) {
        lastSeqByAggregate.set(e.aggregateId, e.seq)
      }

      const events: TrackEvent[] = []
      inputs.forEach((input, i) => {
        const seq = (lastSeqByAggregate.get(input.aggregateId) ?? 0) + 1
        lastSeqByAggregate.set(input.aggregateId, seq)
        const core: EventCore = isBatch
          ? { ...input, cmdId: opts.cmdId!, cmd: { i, n } }
          : { ...input }
        // Materialize ONCE to an inert plain-data snapshot, then hash AND persist that same
        // snapshot — so a live payload (Proxy / getter / toJSON) cannot diverge between the two.
        const materialized = materialize(core) as EventCore
        const contentHash = contentHashOf(materialized)
        const event: TrackEvent = { ...materialized, seq, prevHash, contentHash }
        events.push(event)
        prevHash = contentHash
      })

      // Validate the FULL candidate stream (not just the existing prefix): the command itself
      // could introduce a cross-event violation (e.g. an aggregate-mismatch, a malformed batch).
      const candidate = validate([...existing, ...events])
      if (!candidate.ok) {
        const kinds = candidate.findings.map((f) => f.kind).join(', ')
        throw new Error(
          `EventStore.appendCommand: command would produce an invalid log ` +
            `(${candidate.findings.length} finding(s): ${kinds})`,
        )
      }

      this.appendAtomic(events)
      const expectedHead = {
        streamLength: existing.length + events.length,
        lastContentHash: events[events.length - 1]!.contentHash,
      }
      writeHead(this.filePath, expectedHead)

      // P0 AppendReceipt — the load-bearing guard. STILL UNDER THE LOCK, re-read the persisted log and
      // head and PROVE the write landed. This makes "rc=0 without persistence" structurally impossible:
      // a no-op `appendAtomic`, a short write, a wrong path, or a torn tail all surface as a THROW here
      // (CLI → rc=1), never a silent success. Only a verified receipt returns.
      this.verifyAppend(before, events, expectedHead)
      return events
    }, lockOptionsFromEnv())
  }

  /**
   * Post-write verification (under the append lock). Re-reads the persisted log + head and asserts:
   *  (1) the log grew by exactly `events.length` (length); (2) the persisted suffix matches the
   *  generated events by `id` + `contentHash` (identity); (3) the head's `streamLength` /
   *  `lastContentHash` match the write; (4) the full persisted stream still `validate`s (integrity).
   * Any mismatch throws `append verification failed for <path> …` — the receipt the caller can trust.
   */
  private verifyAppend(
    before: number,
    events: ReadonlyArray<TrackEvent>,
    expectedHead: { streamLength: number; lastContentHash: Sha256 },
  ): void {
    const fail = (reason: string): never => {
      throw new Error(`append verification failed for ${this.filePath}: ${reason}`)
    }

    const after = this.readAll()
    if (after.length !== before + events.length) {
      fail(`length ${after.length} != before ${before} + ${events.length} (write did not persist)`)
    }

    const suffix = after.slice(before)
    for (let i = 0; i < events.length; i++) {
      const persisted = suffix[i]
      const expected = events[i]!
      if (persisted === undefined || persisted.id !== expected.id || persisted.contentHash !== expected.contentHash) {
        fail(
          `persisted suffix[${i}] (id=${persisted?.id ?? '<none>'}, hash=${persisted?.contentHash ?? '<none>'}) ` +
            `!= generated (id=${expected.id}, hash=${expected.contentHash})`,
        )
      }
    }

    const head = readHead(this.filePath)
    if (
      head === null ||
      head.streamLength !== expectedHead.streamLength ||
      head.lastContentHash !== expectedHead.lastContentHash
    ) {
      fail(
        `head mismatch (persisted ${JSON.stringify(head)} != expected ${JSON.stringify(expectedHead)})`,
      )
    }

    const integrity = validate(after, head)
    if (!integrity.ok) {
      const kinds = integrity.findings.map((f) => f.kind).join(', ')
      fail(`persisted stream is invalid (${integrity.findings.length} finding(s): ${kinds})`)
    }
  }

  /**
   * Append all of a command's lines in one fsync'd write. Each line is the event's `canonicalize`
   * form — the SAME serialization used for `contentHash`, so persisted bytes can never diverge
   * from the hashed bytes (immune to prototype pollution / live values). `writeSync` may
   * short-write, so we loop until every byte is flushed. This makes a normal append durable; it
   * does not make a mid-write *crash* atomic — a torn trailing line is reported by
   * `validate`/`readAll` (fail-closed), not silently skipped.
   */
  private appendAtomic(events: ReadonlyArray<TrackEvent>): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const buffer = Buffer.from(events.map((e) => canonicalize(e)).join('\n') + '\n', 'utf8')
    const fd = openSync(this.filePath, 'a')
    try {
      let offset = 0
      while (offset < buffer.length) {
        offset += writeSync(fd, buffer, offset, buffer.length - offset)
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}
