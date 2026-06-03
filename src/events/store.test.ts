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
})
