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
 * Provenance of a write (D3, "hybrid A→B"). `by` is the actor (on whose behalf); `prov` records HOW
 * the write arrived and its TRUST level, so a reviewer of the immutable log can tell a human-CLI
 * write from an agent-proposed one. Optional + additive (absent on pre-D3 events; `canonicalize`
 * drops `undefined`, so adding it never changes an existing event's hash). M3/h2a fills the
 * forward-compat slots (`sig`/`principal`) and flips `auth` to `'signed'`.
 */
export interface Provenance {
  /** Channel the write arrived through. */
  transport: 'cli' | 'mcp-stdio' | 'import' | 'internal'
  /** Agent-PROPOSED (LLM proposes) vs human/deterministic. */
  proposed: boolean
  /**
   * Trust level of `by`: a local user, or an asserted-but-unverified actor. M3/h2a will widen this
   * (additively) with `'signed'` + `sig`/`principal` — NOT defined here so 0.2.0 carries no
   * trust level it cannot yet produce or verify.
   */
  auth: 'local-user' | 'unauthenticated'
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
  /** D3 provenance — present on D3+ writes, absent on older events (additive, hash-covered). */
  prov?: Provenance
  /**
   * Delivery idempotency key (v2.3c). A producer-supplied token; ingest stamps it on every event of a
   * WorkEvent and SKIPS a WorkEvent whose token is already in the log — so a retry is a safe no-op.
   * Additive + hash-covered (absent on older events, which hash identically; `canonicalize` drops
   * `undefined`). Hash-covered because a tampered token would change replay/skip behavior. Unlike `prov`
   * (a per-channel snapshot) this is per-event-varying — correct for a delivery key, and carries no
   * authority (a forged/colliding token only skips the producer's own write).
   */
  clientToken?: string
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
