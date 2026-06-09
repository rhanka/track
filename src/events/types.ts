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
  // Workpackages §2 — set/clear an item's parentId on the EXISTING item aggregate (next seq, no
  // recreate). Past-tense persisted name, mirroring `item.create`→`item.created` (WorkEvent kind
  // `item.reparent`). Additive: absent on every pre-WP event ⇒ zero hash/seq/bucket change.
  'item.reparented',
  // M5 (decision-presentation) — append ONE DossierArtifact to a decision's `dossier.artifacts[]` on the
  // EXISTING decision aggregate (next seq, no whole-dossier rewrite). Past-tense persisted name, mirroring
  // `item.reparent`→`item.reparented` (WorkEvent kind `decision.add-artifact`). Additive: absent on every
  // pre-M5 event ⇒ zero hash/seq/bucket change.
  'decision.artifact-added',
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

/** An attestation signature RECORDED by track (mirrors h2a's `H2ASignature` so an NHI sig drops in
 *  verbatim). It is NOT a signature over track's `EventCore` and NOT a bearer token — it is the
 *  artifact the trusted channel verified, carried for audit. Track NEVER verifies it. */
export interface ProvenanceSignature {
  alg: string // e.g. "Ed25519"
  value: string // base64 signature / non-bearer receipt
  by: string // signer key id / NHI id
}

/**
 * Provenance of a write (D3, "hybrid A→B"). `by` is the actor (on whose behalf); `prov` records HOW
 * the write arrived and its TRUST level, so a reviewer of the immutable log can tell a human-CLI
 * write from an agent-proposed one. Optional + additive (absent on pre-D3 events; `canonicalize`
 * drops `undefined`, so adding it never changes an existing event's hash).
 */
export interface Provenance {
  /** Channel the write arrived through. `'http'` records that the trusted CALLER received the write
   *  over HTTP — track does NOT host HTTP (M3 is library-import; see M3-deps-raci-DESIGN.md). */
  transport: 'cli' | 'mcp-stdio' | 'import' | 'internal' | 'http'
  /** Agent-PROPOSED (LLM proposes) vs human/deterministic. */
  proposed: boolean
  /**
   * Trust level of `by`. `'local-user'` = a local CLI user; `'unauthenticated'` = an asserted-but-
   * unverified actor. **`'signed'` means a verifiable attestation (`principal` + optional `sig`) was
   * RECORDED — it does NOT mean track verified it.** Track is record-only and h2a-free: verification
   * is the trusted channel's job (the platform IdP / the h2a bridge that built the `IngestContext`),
   * and re-verifiability is any consumer's job. Owner-ratified semantics (M3, option ①).
   */
  auth: 'local-user' | 'unauthenticated' | 'signed'
  /** Verified-principal identity the channel attests (NHI id / JWT `sub`). RECORDED, not verified. */
  principal?: string
  /** The attestation signature, recorded for audit (see ProvenanceSignature). RECORDED, not verified. */
  sig?: ProvenanceSignature
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
