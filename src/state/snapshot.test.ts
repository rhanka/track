import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { Track } from '../track.js'
import { fold } from './fold.js'
import { deserializeState, loadLatestSnapshot, saveSnapshot } from './snapshot.js'

let dir: string
let trackDir: string
let store: EventStore
let track: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-snapshot-'))
  trackDir = join(dir, '.track')
  store = new EventStore(join(trackDir, 'events.jsonl'))
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

describe('snapshot (non-authoritative cache)', () => {
  it('is rebuildable: a saved snapshot deserializes to fold(events)', () => {
    const a = track.createItem({ kind: 'feature', title: 'a', workspace: 'ws' })
    track.setRealization(a, 'in-progress')
    track.createItem({ kind: 'bug', title: 'b', workspace: 'ws' })
    const events = store.readAll()

    const saved = saveSnapshot(trackDir, events)
    expect(saved.streamLength).toBe(events.length)

    const loaded = loadLatestSnapshot(trackDir)
    expect(loaded).not.toBeNull()
    expect(deserializeState(loaded!.state)).toEqual(fold(events))
  })

  it('returns null when no snapshot exists', () => {
    expect(loadLatestSnapshot(trackDir)).toBeNull()
  })
})
