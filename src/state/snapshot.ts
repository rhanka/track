import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TrackEvent } from '../events/types.js'
import type { CriterionState, EvidenceState } from '../model/acceptance.js'
import type { BlockerState } from '../model/blocker.js'
import type { DecisionState } from '../model/decision.js'
import type { ItemState } from '../model/item.js'
import type { VerificationRun } from '../model/verification.js'
import { fold, type State } from './fold.js'

/**
 * Snapshots are NON-AUTHORITATIVE caches of `fold(events)` keyed by stream length
 * (SPEC §4: `.track/snapshots/<len>.json`). The append-only log is always the source of truth;
 * a snapshot can be deleted and rebuilt by re-folding.
 */
export interface SerializedState {
  items: ItemState[]
  decisions: DecisionState[]
  blockers: BlockerState[]
  criteria: CriterionState[]
  evidence: EvidenceState[]
  verificationRuns?: VerificationRun[] // Scope §B(c) — additive; absent in older snapshots (rebuildable)
}

export interface Snapshot {
  streamLength: number
  state: SerializedState
}

export function serializeState(state: State): SerializedState {
  // Structured-clone so a caller mutating the serialized form cannot corrupt a live fold.
  return {
    items: [...state.items.values()].map((i) => structuredClone(i)),
    decisions: [...state.decisions.values()].map((d) => structuredClone(d)),
    blockers: [...state.blockers.values()].map((b) => structuredClone(b)),
    criteria: [...state.criteria.values()].map((c) => structuredClone(c)),
    evidence: [...state.evidence.values()].map((e) => structuredClone(e)),
    verificationRuns: [...state.verificationRuns.values()].map((v) => structuredClone(v)),
  }
}

export function deserializeState(serialized: Partial<SerializedState>): State {
  // Tolerate older (pre-Lot-4) snapshots missing newer collections — they are non-authoritative
  // and rebuildable, so an absent array defaults to empty rather than crashing.
  return {
    items: new Map((serialized.items ?? []).map((i) => [i.id, i])),
    decisions: new Map((serialized.decisions ?? []).map((d) => [d.id, d])),
    blockers: new Map((serialized.blockers ?? []).map((b) => [b.id, b])),
    criteria: new Map((serialized.criteria ?? []).map((c) => [c.id, c])),
    evidence: new Map((serialized.evidence ?? []).map((e) => [e.id, e])),
    verificationRuns: new Map((serialized.verificationRuns ?? []).map((v) => [v.runId, v])),
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
