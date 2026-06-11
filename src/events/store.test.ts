import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from './store.js'
import type { CommandEvent } from './types.js'

let dir: string
let store: EventStore
let counter: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-store-'))
  store = new EventStore(join(dir, '.track', 'events.jsonl'))
  counter = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function evt(over: Partial<CommandEvent> = {}): CommandEvent {
  counter += 1
  return {
    id: `evt-${String(counter).padStart(4, '0')}`,
    type: 'item.created',
    aggregate: 'item',
    aggregateId: 'item-A',
    at: `2026-06-03T10:00:${String(counter).padStart(2, '0')}.000Z`,
    by: 'tester',
    payload: { k: counter },
    ...over,
  }
}

describe('EventStore', () => {
  it('round-trips appended events in stream order', () => {
    store.appendCommand([evt()])
    store.appendCommand([evt()])
    const events = store.readAll()

    expect(events).toHaveLength(2)
    expect(events.map((e) => e.id)).toEqual(['evt-0001', 'evt-0002'])
    expect(events[0]!.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('assigns the positional prevHash chain (first null, then previous contentHash)', () => {
    store.appendCommand([evt()])
    store.appendCommand([evt()])
    const [a, b] = store.readAll()

    expect(a!.prevHash).toBeNull()
    expect(b!.prevHash).toBe(a!.contentHash)
  })

  it('assigns per-aggregate seq independently (1-based, contiguous)', () => {
    store.appendCommand([evt({ aggregateId: 'item-A' })])
    store.appendCommand([evt({ aggregateId: 'item-B' })])
    store.appendCommand([evt({ aggregateId: 'item-A' })])
    const events = store.readAll()

    const byAgg = (id: string) => events.filter((e) => e.aggregateId === id).map((e) => e.seq)
    expect(byAgg('item-A')).toEqual([1, 2])
    expect(byAgg('item-B')).toEqual([1])
  })

  it('tags a multi-event command with a shared cmdId and cmd:{i,n}', () => {
    store.appendCommand(
      [
        evt({ aggregate: 'decision', aggregateId: 'dec-1', type: 'decision.outcome' }),
        evt({ aggregate: 'blocker', aggregateId: 'blk-1', type: 'blocker.resolved' }),
        evt({ aggregate: 'item', aggregateId: 'item-X', type: 'realization.transition' }),
      ],
      { cmdId: 'cmd-1' },
    )
    const events = store.readAll()

    expect(events.map((e) => e.cmdId)).toEqual(['cmd-1', 'cmd-1', 'cmd-1'])
    expect(events.map((e) => e.cmd)).toEqual([
      { i: 0, n: 3 },
      { i: 1, n: 3 },
      { i: 2, n: 3 },
    ])
  })

  it('leaves a single-event command standalone (no cmdId / cmd)', () => {
    store.appendCommand([evt()])
    const [only] = store.readAll()
    expect(only!.cmdId).toBeUndefined()
    expect(only!.cmd).toBeUndefined()
  })

  it('rejects a multi-event command without a cmdId', () => {
    expect(() => store.appendCommand([evt(), evt()])).toThrow(/cmdId/)
  })

  it('writes one newline-terminated JSONL line per event', () => {
    store.appendCommand([evt()])
    store.appendCommand([evt()])
    const raw = readFileSync(join(dir, '.track', 'events.jsonl'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.trim().split('\n')).toHaveLength(2)
  })

  it('refuses to extend a tampered log (fail-closed)', () => {
    store.appendCommand([evt()])
    const p = join(dir, '.track', 'events.jsonl')
    const first = JSON.parse(readFileSync(p, 'utf8').trim().split('\n')[0]!) as {
      payload: unknown
    }
    first.payload = { hacked: true }
    writeFileSync(p, JSON.stringify(first) + '\n')
    expect(() => store.appendCommand([evt()])).toThrow(/invalid log/)
  })

  it('rejects a command that would itself produce an invalid log (aggregate-mismatch)', () => {
    expect(() =>
      store.appendCommand(
        [
          evt({ aggregateId: 'X', aggregate: 'item' }),
          evt({ aggregateId: 'X', aggregate: 'blocker', type: 'blocker.opened' }),
        ],
        { cmdId: 'cmd-1' },
      ),
    ).toThrow(/invalid log/)
  })

  it('tolerates a corrupt head.json (rebuildable) and still appends', () => {
    store.appendCommand([evt()])
    writeFileSync(join(dir, '.track', 'head.json'), '{ this is not json')
    expect(() => store.appendCommand([evt()])).not.toThrow()
    expect(store.readAll()).toHaveLength(2)
  })

  it('tolerates a well-formed-JSON but wrong-shape head.json', () => {
    store.appendCommand([evt()])
    writeFileSync(join(dir, '.track', 'head.json'), '{"streamLength":"oops"}')
    expect(() => store.appendCommand([evt()])).not.toThrow()
    expect(store.readAll()).toHaveLength(2)
  })

  // ---- Under-lock clientToken idempotency recheck (concurrent-retry backstop, M3-channel) ----
  describe('clientToken under-lock recheck', () => {
    it('does NOT append a second time when the same (clientToken, aggregateId) is already persisted, and returns the ORIGINAL events', () => {
      const first = store.appendCommand([evt({ clientToken: 't-1' })])
      const before = store.readAll().length
      // A racing retry that bypassed the ingest fast-path: SAME token + aggregateId, fresh call.
      const second = store.appendCommand([evt({ clientToken: 't-1' })])
      expect(store.readAll().length).toBe(before) // nothing re-appended
      expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id)) // original ids returned
      expect(second.map((e) => e.contentHash)).toEqual(first.map((e) => e.contentHash))
    })

    it('returns the SAME persisted events on a tokened retry across a FRESH EventStore over the same file', () => {
      const first = store.appendCommand([evt({ clientToken: 't-fresh' })])
      const reopened = new EventStore(join(dir, '.track', 'events.jsonl'))
      const before = reopened.readAll().length
      const second = reopened.appendCommand([evt({ clientToken: 't-fresh' })])
      expect(reopened.readAll().length).toBe(before)
      expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id))
    })

    it('scopes the recheck per aggregate — the SAME token on a DIFFERENT aggregateId still appends', () => {
      store.appendCommand([evt({ aggregateId: 'item-V', clientToken: 'shared' })])
      const before = store.readAll().length
      store.appendCommand([evt({ aggregateId: 'item-W', clientToken: 'shared' })])
      expect(store.readAll().length).toBe(before + 1) // a different aggregate is NOT suppressed
    })

    it('an UNtokened command still appends every time (no recheck)', () => {
      store.appendCommand([evt()])
      store.appendCommand([evt()])
      expect(store.readAll()).toHaveLength(2)
    })

    it('a FRESH token (never persisted) appends normally', () => {
      store.appendCommand([evt({ clientToken: 'a' })])
      store.appendCommand([evt({ clientToken: 'b' })])
      expect(store.readAll()).toHaveLength(2)
    })

    it('dedups a whole multi-event batch by its shared token, returning the original batch', () => {
      const first = store.appendCommand(
        [
          evt({ aggregate: 'decision', aggregateId: 'dec-1', type: 'decision.created', clientToken: 'batch-1' }),
          evt({ aggregate: 'blocker', aggregateId: 'blk-1', type: 'blocker.opened', clientToken: 'batch-1' }),
        ],
        { cmdId: 'cmd-1' },
      )
      const before = store.readAll().length
      const second = store.appendCommand(
        [
          evt({ aggregate: 'decision', aggregateId: 'dec-1', type: 'decision.created', clientToken: 'batch-1' }),
          evt({ aggregate: 'blocker', aggregateId: 'blk-1', type: 'blocker.opened', clientToken: 'batch-1' }),
        ],
        { cmdId: 'cmd-2' },
      )
      expect(store.readAll().length).toBe(before) // whole batch suppressed
      expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id)) // original batch returned
    })

    it('the recheck keeps the log valid (no torn write, P0 receipt still holds for real appends)', () => {
      store.appendCommand([evt({ clientToken: 't-1' })])
      store.appendCommand([evt({ clientToken: 't-1' })]) // deduped no-op
      const after = store.appendCommand([evt({ clientToken: 't-2' })]) // a real append after a dedup
      expect(store.readAll()).toHaveLength(2)
      expect(after).toHaveLength(1)
    })

    // ---- F4 (faithful filtered return) — exact input batch, never a superset ----
    it('a single-aggregate retry returns EXACTLY the one matching event (not a superset of the token)', () => {
      // Token T legitimately covers {A,B} from one atomic batch.
      const first = store.appendCommand(
        [
          evt({ aggregate: 'item', aggregateId: 'A', clientToken: 'T' }),
          evt({ aggregate: 'item', aggregateId: 'B', clientToken: 'T' }),
        ],
        { cmdId: 'cmd-AB' },
      )
      const before = store.readAll().length
      // Retry of ONLY aggregate A under the same token → must return exactly A's event, not [A,B].
      const second = store.appendCommand([evt({ aggregate: 'item', aggregateId: 'A', clientToken: 'T' })])
      expect(store.readAll().length).toBe(before) // nothing re-appended
      expect(second).toHaveLength(1) // exactly the input aggregate's event, NOT the {A,B} superset
      expect(second[0]!.id).toBe(first[0]!.id) // A's original id
      expect(second[0]!.aggregateId).toBe('A')
    })

    it('a full {A,B} batch retry returns EXACTLY those 2 events in stream order (not more)', () => {
      const first = store.appendCommand(
        [
          evt({ aggregate: 'item', aggregateId: 'A', clientToken: 'T' }),
          evt({ aggregate: 'item', aggregateId: 'B', clientToken: 'T' }),
        ],
        { cmdId: 'cmd-AB' },
      )
      const before = store.readAll().length
      const second = store.appendCommand(
        [
          evt({ aggregate: 'item', aggregateId: 'A', clientToken: 'T' }),
          evt({ aggregate: 'item', aggregateId: 'B', clientToken: 'T' }),
        ],
        { cmdId: 'cmd-AB-retry' },
      )
      expect(store.readAll().length).toBe(before)
      expect(second).toHaveLength(2)
      expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id)) // exactly the original batch, in stream order
    })

    // ---- Case C (F5) — partial overlap of a reused delivery token → fail-closed throw ----
    it('THROWS (fail-closed) when a delivery token is reused across a PARTIAL aggregate overlap, appending nothing', () => {
      // Token T persisted on {A} only.
      store.appendCommand([evt({ aggregate: 'item', aggregateId: 'A', clientToken: 'T' })])
      const before = store.readAll().length
      // A {A,B} command reuses T: A present, B absent → partial overlap → refuse to double-write A.
      expect(() =>
        store.appendCommand(
          [
            evt({ aggregate: 'item', aggregateId: 'A', clientToken: 'T' }),
            evt({ aggregate: 'item', aggregateId: 'B', clientToken: 'T' }),
          ],
          { cmdId: 'cmd-partial' },
        ),
      ).toThrow(/partial overlap|double-write/)
      expect(store.readAll().length).toBe(before) // appended nothing
    })

    // ---- Injectable under-lock dedup hook (the ingest workspace-scoped path) ----
    it('honors an injected `dedupe` hook: when it returns events, NOTHING is appended and exactly those are returned', () => {
      const original = store.appendCommand([evt({ aggregateId: 'item-orig', clientToken: 'tok' })])
      const before = store.readAll().length
      // A racing retry re-mints a FRESH aggregateId; the default (clientToken, aggregateId) dedup would
      // MISS it (Case A → append). An injected hook keyed independently of the aggregateId catches it.
      const seen: Array<{ inputs: number; existing: number }> = []
      const second = store.appendCommand([evt({ aggregateId: 'item-FRESH', clientToken: 'tok' })], {
        dedupe: (inputs, existing) => {
          seen.push({ inputs: inputs.length, existing: existing.length })
          const token = inputs[0]!.clientToken
          const matched = existing.filter((e) => e.clientToken === token)
          return matched.length > 0 ? matched : null
        },
      })
      expect(seen).toHaveLength(1) // the hook ran under the lock with (inputs, existing)
      expect(store.readAll().length).toBe(before) // hook returned non-null → nothing appended
      expect(second.map((e) => e.id)).toEqual(original.map((e) => e.id)) // exactly the hook's events
    })

    it('an injected `dedupe` hook returning null falls through to a normal append', () => {
      store.appendCommand([evt({ clientToken: 'tok' })])
      const before = store.readAll().length
      const appended = store.appendCommand([evt({ aggregateId: 'item-B', clientToken: 'tok' })], {
        dedupe: () => null, // never dedup → append normally
      })
      expect(store.readAll().length).toBe(before + 1)
      expect(appended).toHaveLength(1)
    })

    // ---- F3 — existing-log integrity is proven BEFORE the dedup short-circuit ----
    it('THROWS the integrity error on a CORRUPT existing log even for a duplicate token (no rc=0 on a tampered log)', () => {
      store.appendCommand([evt({ clientToken: 't-corrupt' })])
      const p = join(dir, '.track', 'events.jsonl')
      // Tamper the persisted event's payload WITHOUT updating its contentHash → content-hash finding.
      const first = JSON.parse(readFileSync(p, 'utf8').trim().split('\n')[0]!) as { payload: unknown }
      first.payload = { hacked: true }
      writeFileSync(p, JSON.stringify(first) + '\n')
      // A duplicate-token retry must NOT short-circuit to rc=0 — it must fail closed on the corrupt log.
      expect(() => store.appendCommand([evt({ clientToken: 't-corrupt' })])).toThrow(/invalid log/)
    })
  })
})
