import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { Track } from '../track.js'
import { fold, openBlockers, openBlockersForItem } from './fold.js'

let dir: string
let store: EventStore
let track: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-fold-'))
  store = new EventStore(join(dir, '.track', 'events.jsonl'))
  let n = 0
  track = new Track(store, {
    by: 'tester',
    now: () => '2026-06-03T10:00:00.000Z',
    newId: () => `id-${String(++n).padStart(4, '0')}`,
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('fold (typed state)', () => {
  it('is deterministic on single-stream replay', () => {
    const a = track.createItem({ kind: 'feature', title: 'a', workspace: 'ws' })
    track.setSpec(a, 'specified')
    track.setRealization(a, 'in-progress')
    const events = store.readAll()
    expect(fold(events)).toEqual(fold(events))
  })

  it('projects item axes from the event stream', () => {
    const a = track.createItem({ kind: 'feature', title: 'a', workspace: 'ws' })
    track.setSpec(a, 'specified')
    track.setRealization(a, 'in-progress')
    track.setRealization(a, 'done')

    const item = fold(store.readAll()).items.get(a)!
    expect(item.specStatus).toBe('specified')
    expect(item.realization).toBe('done')
  })

  it('computes open blockers and scopes them to a target', () => {
    const target = track.createItem({ kind: 'feature', title: 't', workspace: 'ws' })
    const other = track.createItem({ kind: 'feature', title: 'o', workspace: 'ws' })
    const ref = track.createItem({ kind: 'feature', title: 'r', workspace: 'ws' })
    track.openBlocker({ targetId: target, kind: 'dependency', ref, reason: 'dep' })

    const state = fold(store.readAll())
    expect(openBlockers(state)).toHaveLength(1)
    expect(openBlockersForItem(state, target)).toHaveLength(1)
    expect(openBlockersForItem(state, other)).toHaveLength(0)
  })

  it('applies the linked-done default when resolutionRule is omitted in the event', () => {
    const ref = track.createItem({ kind: 'feature', title: 'r', workspace: 'ws' })
    const target = track.createItem({ kind: 'feature', title: 't', workspace: 'ws' })
    // A raw blocker.opened with NO resolutionRule (e.g. a hand-written or future-source event).
    store.appendCommand([
      {
        id: 'evt-raw',
        type: 'blocker.opened',
        aggregate: 'blocker',
        aggregateId: 'blk-raw',
        at: '2026-06-03T10:00:00.000Z',
        by: 'tester',
        payload: { blockerId: 'blk-raw', targetId: target, kind: 'dependency', ref, reason: 'dep' },
      },
    ])
    expect(fold(store.readAll()).blockers.get('blk-raw')!.open).toBe(true)

    track.setRealization(ref, 'in-progress')
    track.setRealization(ref, 'done')
    expect(fold(store.readAll()).blockers.get('blk-raw')!.open).toBe(false)
  })

  it('folds an empty stream to empty state', () => {
    const state = fold([])
    expect(state.items.size).toBe(0)
    expect(state.blockers.size).toBe(0)
  })
})
