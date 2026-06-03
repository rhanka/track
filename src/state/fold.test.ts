import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import type { CommandEvent } from '../events/types.js'
import { fold } from './fold.js'

let dir: string
let store: EventStore
let counter: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-fold-'))
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

describe('fold', () => {
  function buildStream() {
    store.appendCommand([evt({ aggregateId: 'item-A', type: 'item.created' })])
    store.appendCommand([evt({ aggregateId: 'item-B', type: 'item.created' })])
    store.appendCommand([evt({ aggregateId: 'item-A', type: 'spec.transition' })])
    store.appendCommand([evt({ aggregateId: 'item-A', type: 'realization.transition' })])
    return store.readAll()
  }

  it('is deterministic on single-stream replay', () => {
    const events = buildStream()
    expect(fold(events)).toEqual(fold(events))
  })

  it('advances per-aggregate state by seq in stream order', () => {
    const state = fold(buildStream())
    const a = state.aggregates.get('item-A')!
    const b = state.aggregates.get('item-B')!

    expect(a.seq).toBe(3)
    expect(a.history).toEqual(['item.created', 'spec.transition', 'realization.transition'])
    expect(b.seq).toBe(1)
    expect(b.history).toEqual(['item.created'])
  })

  it('folds an empty stream to empty state', () => {
    expect(fold([]).aggregates.size).toBe(0)
  })
})
