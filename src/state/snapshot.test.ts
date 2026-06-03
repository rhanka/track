import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import type { CommandEvent } from '../events/types.js'
import { fold } from './fold.js'
import { deserializeState, loadLatestSnapshot, saveSnapshot } from './snapshot.js'

let dir: string
let trackDir: string
let store: EventStore
let counter: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-snapshot-'))
  trackDir = join(dir, '.track')
  store = new EventStore(join(trackDir, 'events.jsonl'))
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

describe('snapshot (non-authoritative cache)', () => {
  it('is rebuildable: a saved snapshot deserializes to fold(events)', () => {
    store.appendCommand([evt({ aggregateId: 'item-A' })])
    store.appendCommand([evt({ aggregateId: 'item-B' })])
    const events = store.readAll()

    const saved = saveSnapshot(trackDir, events)
    expect(saved.streamLength).toBe(2)

    const loaded = loadLatestSnapshot(trackDir)
    expect(loaded).not.toBeNull()
    expect(deserializeState(loaded!.state)).toEqual(fold(events))
  })

  it('returns null when no snapshot exists', () => {
    expect(loadLatestSnapshot(trackDir)).toBeNull()
  })
})
