// Event contract — the frozen core of @sentropic/track (SPEC §3).
// Faithful to the h2a journal model (positional prevHash chain + per-aggregate seq),
// re-expressed for a typed product backlog.

export type Ulid = string
export type ActorId = string
export type Sha256 = `sha256:${string}`

export const AGGREGATES = ['item', 'decision', 'blocker'] as const
export type Aggregate = (typeof AGGREGATES)[number]

export const EVENT_TYPES = [
  'item.created',
  'spec.transition',
  'realization.transition',
  'acceptance.criterion.added',
  'acceptance.evidence.linked',
  'acceptance.run',
  'acceptance.waived',
  'blocker.opened',
  'blocker.resolved',
  'decision.created',
  'decision.disposition',
  'dossier.revised',
  'decision.outcome',
  'priority.assessed',
  'branch.imported',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

/**
 * Position of an event within an atomic command batch.
 * Lot-1 refinement of SPEC §3: the spec frame carries `cmdId?` to correlate a batch but
 * no size, so `validate` cannot detect a *dropped trailing member*. `cmd` makes a batch
 * self-describing (and is covered by `contentHash`). Present iff `cmdId` is present.
 */
export interface CmdPosition {
  i: number // 0-based index within the batch
  n: number // batch size
}

/**
 * The command-supplied core of an event: everything except the integrity frame
 * (`seq`, `prevHash`, `contentHash`). This is exactly the domain hashed into `contentHash`
 * (cf. h2a `stripFrame`).
 */
export interface EventCore {
  id: Ulid
  type: EventType
  aggregate: Aggregate
  aggregateId: Ulid
  at: string // ISO-8601 ms — informational only; ordering authority = stream position + seq
  by: ActorId
  payload: Readonly<Record<string, unknown>>
  cmdId?: Ulid
  cmd?: CmdPosition
}

/** A command's contribution before the store assigns the integrity frame. */
export type CommandEvent = Omit<EventCore, 'cmdId' | 'cmd'>

/** A fully persisted event = core + positional/integrity frame. */
export interface TrackEvent extends EventCore {
  seq: number // per-aggregate, 1-based, strictly contiguous
  prevHash: Sha256 | null // contentHash of the immediately preceding STREAM event (null for the first)
  contentHash: Sha256 // = computeHash(core) — see frame.ts
}
