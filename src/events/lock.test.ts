import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { canonicalize } from './canonical.js'
import { contentHashOf } from './frame.js'
import { readHead, writeHead } from './head.js'
import { EventStore } from './store.js'
import type { EventCore, TrackEvent } from './types.js'
import { validate } from './validate.js'
import { withFileLock } from './lock.js'
import { Track } from '../track.js'

const here = dirname(fileURLToPath(import.meta.url))
const WSJF = { userBusinessValue: 1, timeCriticality: 1, riskReductionOpportunityEnablement: 1, jobSize: 2 }

let dir: string
let target: string
let lockPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-lock-'))
  target = join(dir, '.track', 'events.jsonl')
  lockPath = `${target}.lock`
  mkdirSync(dirname(lockPath), { recursive: true }) // tests that pre-seed a lockfile need .track/ to exist
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('withFileLock — fail-closed mutual exclusion (NO automatic stealing)', () => {
  it('runs fn and releases the lock', () => {
    expect(withFileLock(target, () => 'ran')).toBe('ran')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('releases the lock even when fn throws', () => {
    expect(() => withFileLock(target, () => { throw new Error('boom') })).toThrow('boom')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('times out fail-closed on a held lock, diagnosing a LIVE holder as running', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: 'h', time: Date.now(), token: 't' }))
    expect(() => withFileLock(target, () => 1, { timeoutMs: 150, retryMs: 10 })).toThrow(/timed out.*RUNNING/s)
    expect(existsSync(lockPath)).toBe(true) // NOT stolen — fail-closed even though it could be orphaned
    rmSync(lockPath)
  })

  it('diagnoses a DEAD holder as orphaned/safe-to-delete — but still never auto-steals', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_646, host: 'h', time: Date.now(), token: 't' }))
    expect(() => withFileLock(target, () => 1, { timeoutMs: 150, retryMs: 10 })).toThrow(/NOT running.*safe to delete/s)
    expect(existsSync(lockPath)).toBe(true) // diagnosis guides the human; the lock is left in place
    rmSync(lockPath)
  })

  it('is not reentrant: a nested acquire on the same target times out (holder = ourselves, alive)', () => {
    const result = withFileLock(target, () => {
      expect(() => withFileLock(target, () => 2, { timeoutMs: 150, retryMs: 10 })).toThrow(/timed out/)
      return 1
    })
    expect(result).toBe(1)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('release is ownership-checked: a foreign lock generation is left alone', () => {
    withFileLock(target, () => {
      // Simulate "a human removed an orphan and ANOTHER writer acquired" while fn runs.
      unlinkSync(lockPath)
      writeFileSync(lockPath, JSON.stringify({ pid: 1, host: 'h', time: 0, token: 'foreign' }))
      return 1
    })
    // finally must NOT delete the foreign holder's lock (that would break THEIR mutual exclusion)
    expect(readFileSync(lockPath, 'utf8')).toContain('foreign')
    rmSync(lockPath)
  })

  it('liveness: a live holder is never preempted — the waiter enters only after release', async () => {
    // A separate process acquires the lock and holds it ~1.2s, then releases.
    const script = [
      `const fs = require('node:fs')`,
      `const lock = ${JSON.stringify(lockPath)}`,
      `fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: 'h', time: Date.now(), token: 'holder-child' }), { flag: 'wx' })`,
      `setTimeout(() => { try { fs.unlinkSync(lock) } catch {} }, 1200)`,
    ].join('\n')
    const child = spawn('node', ['-e', script], { stdio: 'pipe' })
    try {
      while (!existsSync(lockPath)) await sleep(10) // wait until the child holds it
      const t0 = Date.now()
      expect(withFileLock(target, () => 'in', { timeoutMs: 8000, retryMs: 15 })).toBe('in')
      const waited = Date.now() - t0
      expect(waited).toBeGreaterThanOrEqual(800) // we WAITED for the release — no steal, no early entry
    } finally {
      child.kill()
    }
  }, 20_000)
})

describe('unlocked-race corruption — negative control proving the harness detects the bug', () => {
  it('the interleaving an unlocked race produces is detected, and bricks all future appends', () => {
    const store = new EventStore(target)
    const t = new Track(store, { by: 'human:t' })
    const itemId = t.createItem({ kind: 'feature', title: 'x', workspace: 'ws' })
    const stalePrefix = store.readAll() // writer B reads the 1-event prefix HERE (pre-A)

    // Writer A appends normally (seq 2, chained to event 1):
    t.assessPriority(itemId, WSJF)

    // Writer B — computed against the STALE prefix — appends the SAME seq/prevHash raw, exactly
    // what the pre-lock interleaving persisted (B cannot see A's append):
    const e1 = stalePrefix[0]!
    const bCore: EventCore = {
      id: '01STALEWRITERB0000000000',
      type: 'priority.assessed',
      aggregate: 'item',
      aggregateId: itemId,
      at: '2026-06-07T00:00:00.000Z',
      by: 'human:t',
      payload: { itemId },
    }
    const bEvent: TrackEvent = { ...bCore, seq: 2, prevHash: e1.contentHash, contentHash: contentHashOf(bCore) }
    appendFileSync(target, `${canonicalize(bEvent)}\n`)
    writeHead(target, { streamLength: 2, lastContentHash: bEvent.contentHash }) // B's stale view of length

    // The exact corruption signature of the race: broken positional chain + duplicate aggregate seq.
    const res = validate(store.readAll(), readHead(target))
    expect(res.ok).toBe(false)
    const kinds = new Set(res.findings.map((f) => f.kind))
    expect(kinds.has('prev-hash')).toBe(true)
    expect(kinds.has('aggregate-seq')).toBe(true)

    // …and the fail-closed guard now refuses EVERY future append: the integrity-DoS itself.
    expect(() => t.assessPriority(itemId, WSJF)).toThrow(/refusing to extend an invalid log/)
  })
})

describe('EventStore.appendCommand — concurrent cross-process writers on the SAME aggregate', () => {
  it('serializes 4 processes × 8 same-aggregate appends into one valid stream (barrier-released)', async () => {
    const WRITERS = 4
    const PER_WRITER = 8

    // One shared aggregate ⇒ every append contends on per-aggregate seq AND the positional chain.
    const itemId = new Track(new EventStore(target), { by: 'human:t' }).createItem({
      kind: 'feature',
      title: 'contended',
      workspace: 'ws',
    })

    // Two-phase READY→GO barrier so the append loops genuinely overlap: each child announces READY,
    // the parent releases them ALL at once only after the full fleet is at the barrier (a fixed
    // startup sleep could undershoot on a slow machine and accidentally serialize the children).
    const goPath = join(dir, 'go')
    const childPath = join(dir, 'append-child.mts')
    writeFileSync(
      childPath,
      [
        `import { existsSync, writeFileSync } from 'node:fs'`,
        `import { EventStore } from ${JSON.stringify(join(here, 'store.ts'))}`,
        `import { Track } from ${JSON.stringify(join(here, '..', 'track.ts'))}`,
        `const [eventsPath, goPath, readyPath, countStr, itemId] = process.argv.slice(2)`,
        `writeFileSync(readyPath!, 'ready') // phase 1: announce`,
        `while (!existsSync(goPath!)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5) // phase 2: hold`,
        `const t = new Track(new EventStore(eventsPath!), { by: 'human:t' })`,
        `for (let i = 0; i < Number(countStr); i++) {`,
        `  t.assessPriority(itemId!, { userBusinessValue: 1, timeCriticality: 1, riskReductionOpportunityEnablement: 1, jobSize: 2 })`,
        `}`,
      ].join('\n'),
    )

    const readyPath = (k: number): string => join(dir, `ready-${k}`)
    const runChild = (k: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const p = spawn('npx', ['tsx', childPath, target, goPath, readyPath(k), String(PER_WRITER), itemId], { stdio: 'pipe' })
        let err = ''
        p.stderr.on('data', (d) => (err += String(d)))
        p.on('error', reject)
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`child c${k} exited ${code}: ${err}`))))
      })

    const children = Promise.all(Array.from({ length: WRITERS }, (_, k) => runChild(k)))
    while (!Array.from({ length: WRITERS }, (_, k) => readyPath(k)).every((p) => existsSync(p))) {
      await sleep(10) // wait for the WHOLE fleet to reach the barrier
    }
    writeFileSync(goPath, 'go') // release them simultaneously
    await children

    const all = new EventStore(target).readAll()
    expect(all.length).toBe(1 + WRITERS * PER_WRITER) // item.created + every append: none lost, none duplicated
    expect(validate(all, readHead(target)).ok).toBe(true) // chain + per-aggregate seq + head all intact
    const seqs = all.filter((e) => e.aggregateId === itemId).map((e) => e.seq)
    expect(seqs).toEqual(Array.from({ length: 1 + WRITERS * PER_WRITER }, (_, i) => i + 1)) // strictly contiguous
    expect(existsSync(lockPath)).toBe(false) // every writer released
  }, 60_000)
})
