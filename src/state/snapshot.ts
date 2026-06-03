import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TrackEvent } from '../events/types.js'
import { fold, type AggregateProjection, type State } from './fold.js'

/**
 * Snapshots are NON-AUTHORITATIVE caches of `fold(events)` keyed by stream length
 * (SPEC §4: `.track/snapshots/<len>.json`). The append-only log is always the source of
 * truth; a snapshot can be deleted and rebuilt by re-folding.
 */
export interface SerializedState {
  aggregates: AggregateProjection[]
}

export interface Snapshot {
  streamLength: number
  state: SerializedState
}

export function serializeState(state: State): SerializedState {
  // Deep-copy `history` so a caller mutating the serialized form cannot corrupt a live fold.
  return {
    aggregates: [...state.aggregates.values()].map((a) => ({ ...a, history: [...a.history] })),
  }
}

export function deserializeState(serialized: SerializedState): State {
  return {
    aggregates: new Map(serialized.aggregates.map((a) => [a.aggregateId, a])),
  }
}

export function saveSnapshot(trackDir: string, events: ReadonlyArray<TrackEvent>): Snapshot {
  const snapshot: Snapshot = {
    streamLength: events.length,
    state: serializeState(fold(events)),
  }
  const dir = join(trackDir, 'snapshots')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${events.length}.json`), JSON.stringify(snapshot, null, 2))
  return snapshot
}

export function loadLatestSnapshot(trackDir: string): Snapshot | null {
  const dir = join(trackDir, 'snapshots')
  if (!existsSync(dir)) return null
  const lengths = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => Number.parseInt(f, 10))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => b - a)
  const latest = lengths[0]
  if (latest === undefined) return null
  return JSON.parse(readFileSync(join(dir, `${latest}.json`), 'utf8')) as Snapshot
}
