import type { Aggregate, EventType, TrackEvent } from '../events/types.js'

/**
 * Per-aggregate projection. Lot 1 ships a generic projection (enough to prove fold
 * determinism); typed Item/Decision/Blocker projections are layered on in Lots 2–4
 * without changing the fold *mechanism* (the frozen part: stream order + per-aggregate seq).
 */
export interface AggregateProjection {
  aggregate: Aggregate
  aggregateId: string
  seq: number // last seq folded for this aggregate
  history: EventType[] // event types in stream order — the deterministic projection signal
}

export interface State {
  aggregates: Map<string, AggregateProjection>
}

/**
 * Deterministic fold: replay events in stream order, routing each to its aggregate by
 * `aggregateId`; per-aggregate state advances by `seq` (SPEC §3). Pure in `events` —
 * `fold(events)` is referentially stable (single-stream replay determinism).
 *
 * Precondition: `events` is a VALIDATED stream (see `validate`). Behaviour on a tampered or
 * non-contiguous stream is unspecified — the store enforces `validate` before every append,
 * so a fold of store-produced events always meets this precondition.
 */
export function fold(events: ReadonlyArray<TrackEvent>): State {
  const aggregates = new Map<string, AggregateProjection>()

  for (const e of events) {
    const current = aggregates.get(e.aggregateId)
    if (current === undefined) {
      aggregates.set(e.aggregateId, {
        aggregate: e.aggregate,
        aggregateId: e.aggregateId,
        seq: e.seq,
        history: [e.type],
      })
    } else {
      current.seq = e.seq
      current.history.push(e.type)
    }
  }

  return { aggregates }
}
