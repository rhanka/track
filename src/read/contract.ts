// Lot v2.0 — curated, VERSIONED read contract (PLAN-v2 M2a).
//
// The MVP barrel (`src/index.ts`) still `export *`s internals; that is the LIBRARY surface. THIS
// module is the *skill-facing read contract* (`scope-check` / `lot-gate` consume it via the
// `@sentropic/track/read` subpath) — reads only (report / query / validate / branch provenance /
// freshness), never mutations, plus a fail-closed `requireFresh` guard so a stale OR tampered
// sidecar can never become de-facto master over BRANCH.md (the source of truth — SPEC §5,
// INTENTION §9 pin).

import { acceptanceStatus, criterionStatus, evidenceForCriterion } from '../accept/status.js'
import type { AcceptanceStatus, CriterionStatus } from '../model/acceptance.js'
import { branchId } from '../branch/parse.js'
import { branchSignature } from '../branch/signature.js'
import { readHead } from '../events/head.js'
import { EventStore } from '../events/store.js'
import type { ActorId, EventType, Provenance, Sha256, TrackEvent } from '../events/types.js'
import { validate, type IntegrityResult } from '../events/validate.js'
import { isRoleContainer, type ItemId, type Realization } from '../model/item.js'
import type { VerificationRun } from '../model/verification.js'
import { bucketOf, type Bucket } from '../report/buckets.js'
import { statusByLevel, type StatusGroup, type StatusLevel } from '../report/status-by-level.js'
import { effectiveOpenBlockersForItem } from '../report/blocker-status.js'
import {
  buildReport,
  query as runQuery,
  type QueryFilter,
  type Report,
  type ReportOptions,
  type ReportRow,
} from '../report/build.js'
import { clipWpTreeToWorkspace } from '../report/rollup.js'
import { auditFindings, type AuditFinding } from '../report/audit.js'
import { fold, type State } from '../state/fold.js'
import type { Dossier, Outcome } from '../model/decision.js'
import type {
  DemandId,
  DemandRaw,
  DemandRef,
  DemandSource,
  DemandStatus,
  DemandType,
} from '../model/demand.js'
import type { WorkEventKind } from '../ingest/contract.js'
import { LeaseStore, isLeaseAbandoned, leasesPathFor, type Lease } from '../lease/store.js'
import {
  scopeValidate as runScopeValidate,
  type ScopeValidateInput,
  type ScopeValidateResult,
} from './scope-validate.js'
import { graphExportFromState, type TrackGraphFragment } from '../graph-export.js'

/**
 * Semver of the skill-facing READ contract.
 *
 * **Policy (PLAN-v2 D7 — additive-only):** within a major, the `TrackReader` surface and the
 * shapes it returns may only GROW (new methods / new optional fields); nothing is removed or
 * repurposed without a major bump. Consumers gate on `reader.contractVersion`.
 */
export const READ_CONTRACT_VERSION = '1.16.0' // +WP-codes A1: WpNode.code? + label may be a durable code (additif)

/** Provenance of the last `branch.imported` for a locator (drawn from the raw event log). */
export interface BranchProvenance {
  locator: string
  branchSlug: string
  /** sha256 of the raw BRANCH.md bytes at import (audit). */
  sourceHash: Sha256
  /** sha256 of the reconciled structural projection — drives freshness. */
  structureHash: Sha256
  at: string
}

/** Result of comparing live BRANCH.md content against the last imported structure. */
export type Freshness =
  | { status: 'fresh'; structureHash: Sha256 }
  | { status: 'stale'; expected: Sha256; actual: Sha256 }
  | { status: 'absent' }

/** Thrown by `requireFresh` when the sidecar is unsafe to consume (stale, absent, or tampered). */
export class StaleSidecarError extends Error {
  constructor(
    message: string,
    readonly detail: { locator: string; freshness: Freshness; integrityOk: boolean },
  ) {
    super(message)
    this.name = 'StaleSidecarError'
  }
}

const isSha256 = (v: unknown): v is Sha256 => typeof v === 'string' && v.startsWith('sha256:')

export type ObjectiveTrackRefKind = 'wp' | 'item' | 'decision' | 'blocker' | 'criterion' | 'evidence' | 'scope'

export type ObjectiveRefRole =
  | 'primary'
  | 'target'
  | 'dependency'
  | 'blocker'
  | 'decision-gate'
  | 'acceptance'
  | 'review'
  | 'evidence'
  | 'advisory'

export interface TrackObjectiveRef {
  system: 'track'
  locator: string
  repoKey: string
  workspace: string
  aggregateKind: ObjectiveTrackRefKind
  aggregateId: string
  role: ObjectiveRefRole
  baselineCommit: string
}

export interface TrackObjectiveRefInput {
  repoKey: string
  workspace: string
  aggregateKind: ObjectiveTrackRefKind
  aggregateId: string
  role: ObjectiveRefRole
  baselineCommit: string
  locator?: string
}

export function trackObjectiveRef(input: TrackObjectiveRefInput): TrackObjectiveRef {
  const locator = input.locator ?? objectiveRefLocator(input)
  const ref: TrackObjectiveRef = { system: 'track', ...input, locator }
  if (ref.locator !== objectiveRefLocator(ref)) throw new Error('track objective ref locator does not match fields')
  return ref
}

export function parseTrackObjectiveRef(locator: string): TrackObjectiveRef {
  const [system, repoKey, workspace, aggregateKind, aggregateId, role, baselineCommit, ...extra] = locator.split(':')
  if (extra.length > 0) throw new Error('track objective ref locator has too many fields')
  if (system !== 'track') throw new Error('track objective ref locator must start with "track"')
  if (!isObjectiveRefKind(aggregateKind)) throw new Error('track objective ref locator has invalid aggregateKind')
  if (!isObjectiveRefRole(role)) throw new Error('track objective ref locator has invalid role')
  return trackObjectiveRef({
    repoKey: decodeLocatorPart(repoKey),
    workspace: decodeLocatorPart(workspace),
    aggregateKind,
    aggregateId: decodeLocatorPart(aggregateId),
    role,
    baselineCommit: decodeLocatorPart(baselineCommit),
    locator,
  })
}

function objectiveRefLocator(ref: Omit<TrackObjectiveRef, 'system' | 'locator'>): string {
  return [
    'track',
    encodeLocatorPart(ref.repoKey),
    encodeLocatorPart(ref.workspace),
    ref.aggregateKind,
    encodeLocatorPart(ref.aggregateId),
    ref.role,
    encodeLocatorPart(ref.baselineCommit),
  ].join(':')
}

function encodeLocatorPart(value: string): string {
  if (value.length === 0) throw new Error('track objective ref fields must be non-empty')
  return encodeURIComponent(value)
}

function decodeLocatorPart(value: string | undefined): string {
  if (value === undefined || value.length === 0) throw new Error('track objective ref locator is incomplete')
  return decodeURIComponent(value)
}

function isObjectiveRefKind(value: unknown): value is ObjectiveTrackRefKind {
  return typeof value === 'string' && ['wp', 'item', 'decision', 'blocker', 'criterion', 'evidence', 'scope'].includes(value)
}

function isObjectiveRefRole(value: unknown): value is ObjectiveRefRole {
  return typeof value === 'string' && ['primary', 'target', 'dependency', 'blocker', 'decision-gate', 'acceptance', 'review', 'evidence', 'advisory'].includes(value)
}

/**
 * An OPEN external (`scope:'extra'`) dependency — a cross-repo/cross-agent blocker awaiting its h2a
 * ENGAGEMENT. This is the read surface an **h2a bridge** watches: when the engagement (`engagementRef`)
 * settles, the bridge resolves the dep via a signed `blocker.resolve` (M3). Track records, never reads h2a.
 */
export interface ExternalDependency {
  blockerId: string
  targetId: string
  engagementRef: string
  openedAt: string
}

/**
 * Why a workspace item/decision/demand is durably stuck (each reason is one PURE staleness predicate).
 * The two demand-axis reasons (`demand-unqualified-idle` / `spec-abandoned-idle`) are ADDITIVE (Build 2):
 * they reuse the EXACT stalled machinery (first-match-wins, `since`) WITHOUT overloading the existing four
 * (an existing consumer that only knows the first four still reads its items unchanged).
 */
export type StalledReason =
  | 'awaited-open-blocker'
  | 'pending-decision'
  | 'in-progress-idle'
  | 'todo-idle'
  // Demand lifecycle (Mode A, Build 2) — the two NEW demand-axis staleness predicates:
  // a `qualifying` demand whose lease is ABANDONED (silent timeout) AND whose latest demand-event predates
  // the window — the demand is unqualified and nobody is actively handling it.
  | 'demand-unqualified-idle'
  // an `agreed` (promoted) item with an ABANDONED spec-lease (a silent spec timeout) — the spec attempt died.
  | 'spec-abandoned-idle'

/** One open leaf item counted in {@link WorkspaceActivity.pending}. */
export interface PendingItem {
  id: ItemId
  title: string
  /** The report bucket that made this item pending (TO-DO or AWAITED). */
  bucket: Extract<Bucket, 'TO-DO' | 'AWAITED'>
  realization: Realization
}

/** One durably-stuck item/decision, with the timestamp the staleness is measured from. */
export interface StalledItem {
  id: ItemId
  title: string
  reason: StalledReason
  /** The `openedAt` / latest-event `at` / creation `at` against which `now − idleMs` was tested. */
  since: string
}

/**
 * A poll-able activity signal for ONE workspace — the read surface an h2a conductor polls for
 * launch-gating (the signal track promised h2a in the sent RACI reply). PURE over the folded log:
 * track holds NO clock, so the caller injects `now`/`idleMs`; identical inputs ⇒ identical output.
 */
export interface WorkspaceActivity {
  workspace: string
  /** Count of items bucketed TO-DO or AWAITED for the workspace (open work; not DONE/DROPPED). */
  pending: number
  /**
   * The concrete open leaf items behind `pending` (same order as the folded item map; containers excluded).
   * OPTIONAL per the read-contract grow-rule (new fields are optional): the producer always emits it, but a
   * versioned consumer pinned to an older contract may not see it — so it never becomes a required shape.
   */
  pendingItems?: PendingItem[]
  /** Items/decisions/demands stuck longer than `idleMs` — the disjunction of the staleness predicates. */
  stalled: StalledItem[]
  /** Max `event.at` scoped to the workspace (informational — h2a corroborates vs live presence). */
  latestEventAt?: string
  /**
   * Demand lifecycle (Mode A, Build 2) — ADDITIVE demand counters for the workspace (absent before this lot;
   * a consumer that never reads it is unaffected). Counts demands by their live lifecycle status.
   */
  demands?: WorkspaceDemandCounts
}

/** Demand counters surfaced on {@link WorkspaceActivity} (Build 2, additive). Open-lifecycle counts. */
export interface WorkspaceDemandCounts {
  /** Demands in `raised` (captured, not yet claimed). */
  raised: number
  /** Demands in `qualifying` (claimed, being qualified). */
  qualifying: number
  /** Demands that reached `agreed` (the PIVOT — promoted to item(s)). */
  agreed: number
}

/** Options for {@link TrackReader.workspaceActivity}. `now`/`idleMs` are CALLER-supplied (no clock here). */
export interface WorkspaceActivityOptions {
  baselineCommit: string
  /** ISO-8601 "current" time supplied by the caller — track holds no clock. */
  now: string
  /** Staleness window in ms; default 24h ⇒ "stalled" = DURABLY stuck. */
  idleMs?: number
  /**
   * Demand lifecycle (Mode A, Build 2) — the ephemeral leases to evaluate abandonment against (PURE: the
   * caller injects them, so the read stays deterministic + testable). Omitted ⇒ read from the side-store
   * beside the log (`.track/leases.json`). Abandonment is computed vs `now` (`now − heartbeatAt > ttlMs`).
   */
  leases?: Lease[]
}

const DEFAULT_IDLE_MS = 86_400_000 // 24h

// ============================================================================================
// M5 (canevas) — the live-out materialization reads. track stays record-only/no-clock/no-socket: the
// HOST owns the clock + fs/git watcher, polls `cursor`, and re-reads `canevas`/`amendmentTrace` on change.
// ============================================================================================

/**
 * A cheap change cursor over the log tail — the host's liveness primitive. `head` is the log-tail event's
 * `contentHash` (null on an empty log); `count` is the event count. The host polls this (O(tail)) and
 * re-reads the materialization reads only when it moves. The cursor changes IFF the log grew.
 */
export interface Cursor {
  head: Sha256 | null
  count: number
}

/** Result of comparing a held cursor against the live log tail. `changed` ⇒ re-read the materialization. */
export interface CursorDelta {
  changed: boolean
  head: Sha256 | null
  count: number
}

/** Origin of a write, DERIVED PURELY from `prov.proposed` (true ⇒ machine/LLM-proposed; false ⇒ human). */
export type AmendmentOrigin = 'human' | 'machine'

/** The prov fields projected onto an amendment-trace step (a read-only summary; never re-verified). */
export interface AmendmentProv {
  proposed: boolean
  auth: Provenance['auth']
  principal?: string
}

/**
 * One ordered, prov-tagged step in an aggregate's amendment trace — the human/machine diff. A PURE replay
 * projection over the aggregate's `spec.amended` / `dossier.revised` / `decision.artifact-added` /
 * `decision.outcome` events: ZERO new event data (`origin` derives from `prov.proposed`). An AI proposal
 * and a human acceptance both appear — the machine origin is NEVER laundered away.
 */
export interface AmendmentStep {
  seq: number
  at: string
  by: ActorId
  kind: EventType
  prov: AmendmentProv
  /** `'machine'` iff `prov.proposed` (an AI proposal); else `'human'`. Derived, not stored. */
  origin: AmendmentOrigin
  summary?: string
  /** For a `spec.amended` step: the opaque resultHash of the patch (the integrity tag track records). */
  patchRef?: string
  /** For a `spec.amended` step: the `proposalRef` it accepts/derives from (proof of non-laundered origin). */
  proposalRef?: string
}

/** A per-aggregate `prov` lineage summary surfaced on the canevas (the latest write's provenance). */
export interface ProvLineage {
  origin: AmendmentOrigin
  proposed: boolean
  auth: Provenance['auth']
  principal?: string
  /** The last event `at` on this aggregate (informational). */
  latestAt: string
}

/** The full decision dossier surfaced when `canevas` is called with a `decisionId`. */
export interface DecisionDossierView {
  id: ItemId
  title: string
  workspace: string
  outcome: Outcome
  dossier: Dossier
}

/** Options for {@link TrackReader.canevas}. `decisionId` opts the full decision dossier into the view. */
export interface CanevasOptions {
  baselineCommit: string
  requireAccepted?: boolean
  decisionId?: ItemId
}

/**
 * The materialized canevas — the host's render input (report + WP rollup, per-aggregate prov lineage +
 * open-action affordances, and, with `decisionId`, the full decision dossier). PURE: no clock, no socket.
 */
export interface CanevasView {
  workspace: string
  /** The materialized report (buckets + decisions + WP rollup forest) for the workspace. */
  report: Report
  /** Per surfaced aggregate id → its `prov` lineage summary (latest write provenance). */
  prov: Record<string, ProvLineage>
  /** Per surfaced aggregate id → the WorkEvent kinds that are a LEGAL next action (open-action affordances). */
  affordances: Record<string, WorkEventKind[]>
  /** Present iff `decisionId` was supplied — the full decision dossier (context/options/qa/outcome/artifacts). */
  dossier?: DecisionDossierView
}

export interface GraphExportOptions {
  repoKey: string
  sourceId: string
  observedAt: string
  sourceFile?: string
}

/**
 * Acceptance-freshness lifecycle — a track-DECIDABLE freshness hint for ONE evidence, ADDITIVE alongside the
 * strict `AcceptanceStatus` (which is unchanged). track holds NO git, so it only exposes the SHAs + a purely-
 * decidable rung; the caller/skill resolves ancestry off these SHAs. The four cases are unambiguous:
 *   - `no-anchor`      — no `realizedCommit` recorded; fall back to the existing strict baselineCommit behavior.
 *   - `anchor-fresh`   — `runCommit === anchorCommit` (string equality against the item's OWN anchor); the run
 *                        was taken at the realization/merge commit ⇒ fresh, never re-staled by an unrelated merge.
 *   - `needs-ancestry` — BOTH SHAs present AND UNEQUAL; track cannot decide (squash/rebase/descendant) — the
 *                        skill resolves it via `git merge-base --is-ancestor` off `runCommit`/`anchorCommit`.
 *   - `no-run`         — an `anchorCommit` is present but the evidence has NO run SHA to compare; a skill CANNOT
 *                        run ancestry without a run SHA, so this is its OWN value (distinct from `needs-ancestry`).
 */
export type AnchorFreshness = 'anchor-fresh' | 'needs-ancestry' | 'no-anchor' | 'no-run'

/** Per-evidence anchor-freshness detail (run-SHA + the item's anchor-SHA + the track-decidable hint). */
export interface EvidenceAcceptanceDetail {
  evidenceId: string
  criterionId: string
  /** The latest recorded run's commit for this evidence (undefined ⇒ no run recorded). */
  runCommit?: string
  /** The item's realization anchor commit (`ItemState.realizedCommit`), undefined ⇒ no anchor. */
  anchorCommit?: string
  /** The track-decidable freshness hint (see {@link AnchorFreshness}); the caller resolves ancestry. */
  freshness: AnchorFreshness
}

/** Per-criterion acceptance detail (its evidence details + the strict per-criterion status, unchanged). */
export interface CriterionAcceptanceDetail {
  criterionId: string
  /** The existing strict per-criterion status against `baselineCommit` (UNCHANGED logic, surfaced for context). */
  status: CriterionStatus
  evidence: EvidenceAcceptanceDetail[]
}

/**
 * Per-item acceptance DETAIL — the anchor-freshness read surface the skill consumes. ADDITIVE alongside the
 * strict `acceptanceStatus` (surfaced as `status`, UNCHANGED logic). Pure/read-only/clockless; track decides
 * only the `anchor-fresh`/`needs-ancestry`/`no-anchor`/`no-run` rung — the caller/skill resolves git ancestry off the SHAs.
 */
export interface AcceptanceDetail {
  itemId: ItemId
  /** The item's realization anchor commit (`ItemState.realizedCommit`), undefined ⇒ no anchor. */
  anchorCommit?: string
  /** The existing strict per-item acceptance status against `baselineCommit` (UNCHANGED logic). */
  status: AcceptanceStatus
  criteria: CriterionAcceptanceDetail[]
}

// The persisted event types projected into an aggregate's amendment trace (the human/machine diff source).
const AMENDMENT_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'spec.amended',
  'dossier.revised',
  'decision.artifact-added',
  'decision.outcome',
])

/**
 * The open-action affordances for ONE non-decision item: the WorkEvent kinds that are a LEGAL next action
 * given its current spec/realization state (the canevas shows the human/AI exactly what they may submit).
 * Derived from the same monotone transition machines the facade enforces — a superset is fine (the facade
 * re-checks), but we mirror the real legality so the canevas never offers a dead button.
 */
function itemAffordances(state: State, itemId: ItemId): WorkEventKind[] {
  const item = state.items.get(itemId)
  if (item === undefined) return []
  const out: WorkEventKind[] = []
  // Spec axis (monotone to-specify → specified). A spec amendment is always offerable (record-only).
  if (item.specStatus === 'to-specify') out.push('item.spec')
  out.push('item.spec-amend')
  // Realization axis (forward transitions; terminal states offer nothing).
  if (item.realization === 'to-do') out.push('item.realize')
  else if (item.realization === 'in-progress') out.push('item.realize')
  // Cross-cutting actions available while the item is live (not terminal).
  if (item.realization !== 'done' && item.realization !== 'cancelled' && item.realization !== 'rejected') {
    out.push('item.reparent', 'priority.assess', 'acceptance.criterion', 'blocker.raise')
  }
  return out
}

/** Open-action affordances for a decision, by its outcome state (the outcome machine the facade enforces). */
function decisionAffordances(outcome: Outcome): WorkEventKind[] {
  // Whole-dossier revise + an append-only artifact are always offerable; outcome only until terminal.
  const out: WorkEventKind[] = ['decision.dossier', 'decision.add-artifact']
  if (outcome === 'pending' || outcome === 'deferred') out.push('decision.outcome')
  return out
}

// ============================================================================================
// Demand lifecycle (Mode A, Build 2) — the demand-axis read surface. PURE/clockless: a `demand`'s lease
// state is computed by the READER against an injected `now` (`abandoned ⇔ now − heartbeatAt > ttlMs`); the
// durable lifecycle facts (raised/qualifying/agreed/disposition + spec.started/spec.abandoned) come straight
// from the folded state + the raw log. The ephemeral lease NEVER gates an append — it is purely a read input.
// ============================================================================================

/** The advisory lease state for a demand/item subject, evaluated vs an injected `now` (DESIGN §Reads). */
export type LeaseState = 'none' | 'live' | 'abandoned'

/**
 * The materialized read view of ONE demand (DESIGN §Reads). PURE projection over the folded `DemandState`
 * + the ephemeral lease (vs `now`). `lastHandler` is folded from the latest demand-axis event's `handler`;
 * `currentHandler` is the LIVE lease holder (undefined when there is no lease OR it is abandoned). The
 * `affordances` are the legal next WorkEvent kinds for the demand's status (the canevas's dead-button-free
 * open actions).
 */
export interface DemandView {
  id: DemandId
  status: DemandStatus
  type: DemandType
  raw: DemandRaw
  source: DemandSource
  itemIds?: ItemId[]
  duplicateOf?: DemandRef
  /** The handler folded from the LATEST demand-axis event on this demand (who LAST acted). */
  lastHandler?: ActorId
  /** The handler of the LIVE lease on this demand (undefined when none/abandoned) — who is handling NOW. */
  currentHandler?: ActorId
  /** The advisory lease state vs the injected `now`: no lease / live / abandoned (silent-timeout F1). */
  leaseState: LeaseState
  /** The legal next WorkEvent kinds given the demand's status (open-action affordances). */
  affordances: WorkEventKind[]
}

/**
 * Open-action affordances for a demand by its lifecycle status (DESIGN §Reads):
 *   raised → [demand.claim]; qualifying → [demand.agree, demand.disposition]; parked → [demand.claim];
 *   terminal (agreed/rejected/duplicate) → []. Mirrors `DEMAND_TRANSITIONS` so the canevas never offers a
 *   dead button (the facade re-checks legality at append).
 */
function demandAffordances(status: DemandStatus): WorkEventKind[] {
  switch (status) {
    case 'raised':
    case 'parked':
      return ['demand.claim']
    case 'qualifying':
      return ['demand.agree', 'demand.disposition']
    default:
      return [] // agreed / rejected / duplicate — terminal on the demand axis
  }
}

// The persisted event types projected into a demand's lifecycle trace (the demand-axis amendment sibling).
const DEMAND_LIFECYCLE_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'demand.raised',
  'demand.qualifying-started',
  'demand.agreed',
  'demand.disposition',
])
// The persisted event types projected into an ITEM's lifecycle trace (the spec-attempt handler facts + the
// item.created promotion + the spec/realization transitions that carry a handler).
const ITEM_LIFECYCLE_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'item.created',
  'spec.started',
  'spec.abandoned',
  'spec.transition',
  'realization.transition',
])

/** Origin of a lifecycle step's write — `'agent'` iff `prov.proposed` (an AI proposal), else `'human'`. */
export type LifecycleOrigin = AmendmentOrigin

/**
 * The demand status a lifecycle STEP transitions TO (for demand-axis events only). raised⇒raised;
 * qualifying-started⇒qualifying; agreed⇒agreed; disposition⇒its `outcome` (rejected|duplicate|parked).
 * Returns undefined for item/spec steps (those carry no demand status).
 */
function demandStatusOfStep(type: EventType, outcome: unknown): DemandStatus | undefined {
  switch (type) {
    case 'demand.raised':
      return 'raised'
    case 'demand.qualifying-started':
      return 'qualifying'
    case 'demand.agreed':
      return 'agreed'
    case 'demand.disposition':
      return typeof outcome === 'string' ? (outcome as DemandStatus) : undefined
    default:
      return undefined
  }
}

/**
 * One ordered, prov-tagged + HANDLER-tagged step in a demand/item aggregate's lifecycle trace (DESIGN
 * §Reads — the demand-axis sibling of `amendmentTrace`). A PURE replay projection over the aggregate's
 * lifecycle events (ZERO new event data). Carries `{seq, at, by, handler?, status?, prov, origin}`: `by` is
 * the event writer; `handler` is the folded "qui traite" (the h2a instance id from the payload); `status` is
 * the demand status this step transitions TO (for a demand step); `origin` derives from `prov.proposed`.
 */
export interface LifecycleStep {
  seq: number
  at: string
  by: ActorId
  kind: EventType
  /** The handler ("qui traite", the h2a instance id) recorded on the step's payload (when present). */
  handler?: ActorId
  /** The demand status this step transitions TO (demand steps only; absent for item/spec steps). */
  status?: DemandStatus
  prov: AmendmentProv
  /** `'machine'` iff `prov.proposed` (an AI proposal); else `'human'`. Derived, not stored. */
  origin: LifecycleOrigin
}

/** The subject of a {@link TrackReader.lifecycleTrace} — a demand or an item aggregate. */
export interface LifecycleSubject {
  kind: 'demand' | 'item'
  id: string
}

/** Options for {@link TrackReader.demands}. `now` is CALLER-supplied (track holds no clock). */
export interface DemandsOptions {
  /** ISO-8601 "current" time supplied by the caller — abandonment is computed vs this (no clock here). */
  now: string
  /**
   * The ephemeral leases to evaluate (PURE: caller-injected ⇒ deterministic + testable). Omitted ⇒ read from
   * the side-store beside the log (`.track/leases.json`). Abandonment: `now − heartbeatAt > ttlMs`.
   */
  leases?: Lease[]
  /** Reserved staleness window (ms) — accepted for forward-compat with the DESIGN signature; unused today. */
  idleMs?: number
}

/**
 * Read-only, versioned consumption surface over a frozen track log. Holds NO `git` and only reads
 * the event file/head via `fs` — a baseline commit is supplied by the caller via `ReportOptions`
 * (the adapter owns `git`, not this layer — PLAN-v2 stack note).
 */
export class TrackReader {
  readonly contractVersion = READ_CONTRACT_VERSION
  private readonly store: EventStore

  constructor(private readonly eventsPath: string) {
    this.store = new EventStore(eventsPath)
  }

  private events(): TrackEvent[] {
    return this.store.readAll()
  }

  /** Bucketed backlog report (SPEC §7). */
  report(options: ReportOptions): Report {
    return buildReport(fold(this.events()), options)
  }

  /** Flat, filtered query over report rows (SPEC §6). */
  query(filter: QueryFilter, options: ReportOptions): ReportRow[] {
    return runQuery(fold(this.events()), filter, options)
  }

  /**
   * M5 (canevas) — a cheap change cursor: the log-tail `contentHash` (head) + event `count`, O(tail). The
   * HOST's liveness primitive: poll this, re-read `canevas`/`amendmentTrace` on change. PURE (no clock, no
   * socket). The cursor changes IFF the log grew.
   */
  cursor(): Cursor {
    const head = readHead(this.eventsPath)
    if (head !== null) return { head: head.lastContentHash, count: head.streamLength }
    // No head anchor (or a malformed one): derive from the log tail directly — equally O(tail).
    const events = this.events()
    const last = events.at(-1)
    return { head: last !== undefined ? last.contentHash : null, count: events.length }
  }

  /**
   * M5 (canevas) — has the log grown since `cursor`? Returns the LIVE cursor + a `changed` flag (the head
   * hash OR count differs). The host holds a cursor from its last read and calls this to decide whether to
   * re-materialize. PURE.
   */
  changesSince(cursor: Cursor): CursorDelta {
    const live = this.cursor()
    return { changed: live.head !== cursor.head || live.count !== cursor.count, head: live.head, count: live.count }
  }

  /** WP6 — graphify Extraction fragment over the current TrackReader state. */
  graphExport(options: GraphExportOptions): TrackGraphFragment {
    const events = this.events()
    const last = events.at(-1)
    return graphExportFromState(fold(events), {
      repoKey: options.repoKey,
      sourceId: options.sourceId,
      observedAt: options.observedAt,
      sourceHash: last?.contentHash ?? 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ...(options.sourceFile !== undefined ? { sourceFile: options.sourceFile } : {}),
    })
  }

  /**
   * M5 (canevas) — the materialized canevas for ONE workspace: the report + WP rollup (reusing
   * `buildReport` with `wpTree`/`decisions`), joined per surfaced aggregate with its `prov` lineage summary
   * (latest write provenance) + open-action affordances (the WorkEvent kinds that are a LEGAL next action).
   * With `decisionId`, also includes the full decision dossier (context/options/qa/outcome/artifacts). PURE:
   * no clock, no socket — the host owns liveness (poll `cursor`, re-read here on change).
   */
  canevas(workspace: string, opts: CanevasOptions): CanevasView {
    const events = this.events()
    const state = fold(events)
    const baseReport = buildReport(state, {
      baselineCommit: opts.baselineCommit,
      requireAccepted: opts.requireAccepted ?? false,
      decisions: true,
      wpTree: true,
    })
    // Scope the report to the workspace: filter bucket rows, decision rows, and the WP forest (a WP whose
    // workspace ≠ the named one is dropped). buildReport is global; the canevas is per-workspace.
    const report: Report = {
      buckets: {
        AWAITED: baseReport.buckets.AWAITED.filter((r) => r.workspace === workspace),
        DROPPED: baseReport.buckets.DROPPED.filter((r) => r.workspace === workspace),
        DONE: baseReport.buckets.DONE.filter((r) => r.workspace === workspace),
        'TO-DO': baseReport.buckets['TO-DO'].filter((r) => r.workspace === workspace),
      },
      ...(baseReport.decisions !== undefined
        ? { decisions: baseReport.decisions.filter((d) => d.workspace === workspace) }
        : {}),
      // DESIGN R3a — a TRUE leaf-clip (not the old node-filter): keep only leaves with item.workspace===W,
      // retain a node iff ≥1 W-leaf in its subtree (so W leaves under a V-rooted WP are NOT lost), recompute
      // W-only counts, and mark `partial`. Mono-workspace ⇒ byte-identical (no node dropped, no `partial`).
      ...(baseReport.wpTree !== undefined ? { wpTree: clipWpTreeToWorkspace(baseReport.wpTree, workspace) } : {}),
    }

    // Per-aggregate prov lineage (latest write on each surfaced aggregate) + open-action affordances. We
    // surface every item/decision in the workspace (bucket rows AND WP containers AND decisions).
    const latestProvAt = new Map<string, { prov?: Provenance; at: string }>()
    for (const e of events) {
      const prev = latestProvAt.get(e.aggregateId)
      if (prev === undefined || e.at >= prev.at) {
        latestProvAt.set(e.aggregateId, { ...(e.prov !== undefined ? { prov: e.prov } : {}), at: e.at })
      }
    }
    const prov: Record<string, ProvLineage> = {}
    const affordances: Record<string, WorkEventKind[]> = {}
    const surface = (id: string): void => {
      const meta = latestProvAt.get(id)
      const p = meta?.prov
      const proposed = p?.proposed ?? false
      prov[id] = {
        origin: proposed ? 'machine' : 'human',
        proposed,
        auth: p?.auth ?? 'local-user',
        ...(p?.principal !== undefined ? { principal: p.principal } : {}),
        latestAt: meta?.at ?? '',
      }
    }
    for (const item of state.items.values()) {
      if (item.workspace !== workspace) continue
      surface(item.id)
      affordances[item.id] = itemAffordances(state, item.id)
    }
    for (const d of state.decisions.values()) {
      if (d.workspace !== workspace) continue
      surface(d.id)
      affordances[d.id] = decisionAffordances(d.outcome)
    }
    // Demand lifecycle (Mode A, Build 2) — surface demands ON THE CANEVAS (reuse the latestProvAt loop keyed
    // on the demand aggregateId) + demand affordances (legal next actions by status). Demands are NOT items,
    // so they never appear in `report.buckets`; they get their own prov-lineage + affordance entries here.
    for (const demand of state.demands.values()) {
      if (demand.workspace !== workspace) continue
      surface(demand.id)
      affordances[demand.id] = demandAffordances(demand.status)
    }

    const view: CanevasView = { workspace, report, prov, affordances }
    if (opts.decisionId !== undefined) {
      const d = state.decisions.get(opts.decisionId)
      if (d !== undefined) {
        view.dossier = { id: d.id, title: d.title, workspace: d.workspace, outcome: d.outcome, dossier: d.dossier }
      }
    }
    return view
  }

  /**
   * DESIGN R4 (Lot 2) — the DETERMINISTIC structural audit: `AuditFinding[]` over the folded log (orphan,
   * empty-wp, duplicate, cross-workspace-subtree, singleton-workspace). PURE; no clock, no I/O. A SEPARATE
   * producer (not inlined in the directive selector). Read-only — emits nothing.
   */
  audit(): AuditFinding[] {
    return auditFindings(fold(this.events()))
  }

  /**
   * M5 (canevas) — the human/machine diff: an ORDERED (by seq), prov-tagged projection over the aggregate's
   * `spec.amended` / `dossier.revised` / `decision.artifact-added` / `decision.outcome` events. PURE replay;
   * ZERO new event data — `origin` derives from `prov.proposed` (true ⇒ machine, false ⇒ human). An AI
   * proposal (proposed:true, with a proposalRef) and a human acceptance (referencing the same proposalRef)
   * BOTH appear — the machine origin is NEVER laundered away.
   */
  amendmentTrace(aggregateId: ItemId): AmendmentStep[] {
    const steps: AmendmentStep[] = []
    for (const e of this.events()) {
      if (e.aggregateId !== aggregateId) continue
      if (!AMENDMENT_EVENT_TYPES.has(e.type)) continue
      const proposed = e.prov?.proposed ?? false
      const p = e.payload as { summary?: unknown; resultHash?: unknown; proposalRef?: unknown }
      steps.push({
        seq: e.seq,
        at: e.at,
        by: e.by,
        kind: e.type,
        prov: {
          proposed,
          auth: e.prov?.auth ?? 'local-user',
          ...(e.prov?.principal !== undefined ? { principal: e.prov.principal } : {}),
        },
        origin: proposed ? 'machine' : 'human',
        ...(typeof p.summary === 'string' ? { summary: p.summary } : {}),
        ...(typeof p.resultHash === 'string' ? { patchRef: p.resultHash } : {}),
        ...(typeof p.proposalRef === 'string' ? { proposalRef: p.proposalRef } : {}),
      })
    }
    return steps.sort((a, b) => a.seq - b.seq)
  }

  /**
   * Demand lifecycle (Mode A, Build 2) — the materialized DEMAND views for ONE workspace (DESIGN §Reads).
   * PURE/clockless: per demand, the folded lifecycle state (`status`/`type`/`raw`/`source`/`itemIds`/
   * `duplicateOf`) + `lastHandler` (folded from the LATEST demand-axis event's handler) + `currentHandler`
   * (the LIVE lease holder, undefined when none/abandoned) + `leaseState` (`none`/`live`/`abandoned`, vs the
   * injected `now`) + `affordances` (legal next WorkEvent kinds by status). The leases are caller-injected
   * (deterministic) OR read from the side-store beside the log; the lease NEVER gated the durable facts.
   */
  demands(workspace: string, opts: DemandsOptions): DemandView[] {
    const events = this.events()
    const state = fold(events)
    const leases = this.loadLeases(opts.leases)
    // The handler folded from the LATEST demand-axis event per demand (who LAST acted on the demand axis).
    const lastHandler = new Map<DemandId, ActorId>()
    for (const e of events) {
      if (!DEMAND_LIFECYCLE_EVENT_TYPES.has(e.type)) continue
      const h = (e.payload as { handler?: unknown }).handler
      if (typeof h === 'string') lastHandler.set(e.aggregateId, h) // stream order ⇒ last write wins
    }
    const out: DemandView[] = []
    for (const demand of state.demands.values()) {
      if (demand.workspace !== workspace) continue
      const lease = leases.find((l) => l.subject.kind === 'demand' && l.subject.id === demand.id)
      const leaseState: LeaseState =
        lease === undefined ? 'none' : isLeaseAbandoned(lease, opts.now) ? 'abandoned' : 'live'
      const handler = lastHandler.get(demand.id)
      out.push({
        id: demand.id,
        status: demand.status,
        type: demand.type,
        raw: demand.raw,
        source: demand.source,
        leaseState,
        affordances: demandAffordances(demand.status),
        ...(demand.itemIds !== undefined ? { itemIds: demand.itemIds } : {}),
        ...(demand.duplicateOf !== undefined ? { duplicateOf: demand.duplicateOf } : {}),
        ...(handler !== undefined ? { lastHandler: handler } : {}),
        // currentHandler = the LIVE lease holder ONLY (undefined when none/abandoned — F1 silent timeout).
        ...(leaseState === 'live' ? { currentHandler: lease!.holder } : {}),
      })
    }
    return out
  }

  /**
   * Demand lifecycle (Mode A, Build 2) — the ORDERED (by seq), prov-tagged + HANDLER-tagged lifecycle
   * projection over an aggregate's lifecycle events (DESIGN §Reads — the demand-axis sibling of
   * `amendmentTrace`). For a `demand`: demand.raised / qualifying-started / agreed / disposition. For an
   * `item`: item.created (the promotion) + spec.started / spec.abandoned (the durable handler facts) +
   * spec/realization transitions. PURE replay; ZERO new event data. Each step carries
   * `{seq, at, by, handler?, status?, prov, origin}` — `origin` derives from `prov.proposed`. The DURABLE
   * `spec.abandoned` (explicit abandon, F1) surfaces here, distinct from a silent lease timeout (which has
   * NO durable fact and surfaces only via `demands()`/`workspaceActivity`'s lease state).
   */
  lifecycleTrace(subject: LifecycleSubject): LifecycleStep[] {
    const wanted = subject.kind === 'demand' ? DEMAND_LIFECYCLE_EVENT_TYPES : ITEM_LIFECYCLE_EVENT_TYPES
    const steps: LifecycleStep[] = []
    for (const e of this.events()) {
      if (e.aggregateId !== subject.id) continue
      if (!wanted.has(e.type)) continue
      const proposed = e.prov?.proposed ?? false
      const p = e.payload as { handler?: unknown; outcome?: unknown }
      const status = demandStatusOfStep(e.type, p.outcome)
      steps.push({
        seq: e.seq,
        at: e.at,
        by: e.by,
        kind: e.type,
        prov: {
          proposed,
          auth: e.prov?.auth ?? 'local-user',
          ...(e.prov?.principal !== undefined ? { principal: e.prov.principal } : {}),
        },
        origin: proposed ? 'machine' : 'human',
        ...(typeof p.handler === 'string' ? { handler: p.handler } : {}),
        ...(status !== undefined ? { status } : {}),
      })
    }
    return steps.sort((a, b) => a.seq - b.seq)
  }

  /** Load the leases to evaluate: caller-injected (deterministic) OR the side-store beside the log. */
  private loadLeases(injected?: Lease[]): Lease[] {
    if (injected !== undefined) return injected
    return new LeaseStore(leasesPathFor(this.eventsPath)).readAll()
  }

  /**
   * Scope §A/§B — `status(level)` projection (spec|plan|wp|lot|task). Additive read-only generalization
   * of `computeWpTree`+`bucketOf`; adds no aggregate, no stored status axis. `requireAccepted` (default
   * false) and `baselineCommit` govern the underlying leaf buckets exactly as in `report`.
   */
  statusByLevel(level: StatusLevel, options: ReportOptions): StatusGroup[] {
    return statusByLevel(fold(this.events()), level, {
      baselineCommit: options.baselineCommit,
      requireAccepted: options.requireAccepted ?? false,
    })
  }

  /**
   * Acceptance-freshness lifecycle — the anchor-freshness DETAIL for ONE item. ADDITIVE: the strict
   * `acceptanceStatus`/`criterionStatus` (against `baselineCommit`) are surfaced VERBATIM as `status` (their
   * logic is UNCHANGED — back-compat); this detail ADDS, per criterion/evidence, the run-SHA + the item's
   * anchor-SHA (`realizedCommit`) + a track-decidable freshness hint (`anchor-fresh`/`needs-ancestry`/
   * `no-anchor`/`no-run`). PURE/read-only/CLOCKLESS and git-free: track decides only the purely-decidable rung; the
   * caller/skill resolves ancestry off the two SHAs (see {@link AnchorFreshness}). `baselineCommit` drives
   * ONLY the strict `status` fields — the freshness hint is measured against the item's OWN anchor, never HEAD.
   */
  acceptanceDetail(itemId: ItemId, baselineCommit: string): AcceptanceDetail {
    const state = fold(this.events())
    const anchorCommit = state.items.get(itemId)?.realizedCommit
    const criteria = [...state.criteria.values()].filter((c) => c.itemId === itemId)
    const hintFor = (runCommit: string | undefined): AnchorFreshness => {
      if (anchorCommit === undefined) return 'no-anchor' // fall back to the strict baselineCommit behavior
      if (runCommit === undefined) return 'no-run' // an anchor exists but no run SHA — ancestry is impossible
      return runCommit === anchorCommit ? 'anchor-fresh' : 'needs-ancestry' // equality ⊊ ancestry → defer
    }
    const criteriaDetail: CriterionAcceptanceDetail[] = criteria.map((c) => ({
      criterionId: c.id,
      status: criterionStatus(state, c.id, baselineCommit),
      evidence: evidenceForCriterion(state, c.id).map((e) => {
        const runCommit = e.latestRun?.commit
        return {
          evidenceId: e.id,
          criterionId: c.id,
          ...(runCommit !== undefined ? { runCommit } : {}),
          ...(anchorCommit !== undefined ? { anchorCommit } : {}),
          freshness: hintFor(runCommit),
        }
      }),
    }))
    return {
      itemId,
      ...(anchorCommit !== undefined ? { anchorCommit } : {}),
      status: acceptanceStatus(state, itemId, baselineCommit),
      criteria: criteriaDetail,
    }
  }

  /** Recompute the integrity chain (SPEC §3) — pure detector, never repairs. */
  validate(): IntegrityResult {
    return validate(this.events(), readHead(this.eventsPath))
  }

  /**
   * Open external (`scope:'extra'`) dependencies — what an h2a bridge watches to resolve when an
   * ENGAGEMENT settles (Lot C). Read-only; the bridge resolves each via a signed `blocker.resolve`.
   * Baseline-free (an external dep resolves only by an explicit event, never commit-relative).
   */
  externalDependencies(): ExternalDependency[] {
    const state = fold(this.events())
    const out: ExternalDependency[] = []
    for (const b of state.blockers.values()) {
      if (b.open && b.kind === 'dependency' && b.scope === 'extra' && b.engagementRef !== undefined) {
        out.push({ blockerId: b.id, targetId: b.targetId, engagementRef: b.engagementRef, openedAt: b.openedAt })
      }
    }
    return out
  }

  /**
   * Scope §B(c) — the recorded path-scope VerificationRuns (the read surface a future `scope validate`
   * reads, never recomputes). EVIDENCE-ONLY: each is the latest-per-runId verdict folded from the log;
   * track NEVER glob-matches — `violations` are the harness's verbatim offending paths. `wpRef` filters
   * to one WP/phase; absent ⇒ all runs (workspace-scoped + wpRef'd). Sorted by `at` then `runId`.
   */
  verificationRuns(wpRef?: ItemId): VerificationRun[] {
    const runs = [...fold(this.events()).verificationRuns.values()]
    const filtered = wpRef !== undefined ? runs.filter((r) => r.wpRef === wpRef) : runs
    return filtered.sort((a, b) => a.at.localeCompare(b.at) || a.runId.localeCompare(b.runId))
  }

  /**
   * Scope §B(b) — `track scope validate`: a PURE, read-only, fail-closed, ADVISORY validation of the
   * declarative scope state. It NEVER glob-matches (string-level set logic), NEVER ingests, NEVER appends,
   * and is NEVER a commit gate.
   *
   * FAIL-CLOSED: when `content`+`locator` are supplied, `requireFresh` runs FIRST (REUSING the shipped
   * mechanism) — a stale / altered / not-imported sidecar throws `StaleSidecarError`, surfaced here as
   * `{status:'stale', findings:[], perWp:[]}` with NO partial verdict (never a silent fallback). When no
   * sidecar is given, the validation runs directly over the folded log.
   *
   * Validates (semantic, pure): every realization-active WP/spec-phase has a `scope` (else 'scope-undeclared');
   * no allowed∩forbidden string overlap ('incoherent'); legal spec-phase nesting ('illegal-nesting'); an
   * optional claimed item is a descendant of a declared phase ('claim-out-of-phase'). Surfaces the latest
   * ingested VerificationRun verdict per WP (READ, never recomputed). Optional opt-in 'delivered-out-of-scope'.
   */
  scopeValidate(
    opts: ScopeValidateInput & { content?: string; locator?: string },
  ): ScopeValidateResult {
    const events = this.events()
    // FAIL-CLOSED gate FIRST: a supplied sidecar must be fresh + integral, or no verdict is produced.
    if (opts.content !== undefined && opts.locator !== undefined) {
      try {
        this.requireFresh(opts.content, opts.locator)
      } catch (error) {
        if (error instanceof StaleSidecarError) {
          return { status: 'stale', findings: [], perWp: [] }
        }
        throw error
      }
    }
    return runScopeValidate(fold(events), {
      workspace: opts.workspace,
      baselineCommit: opts.baselineCommit,
      ...(opts.inferDeliveredOutOfScope !== undefined ? { inferDeliveredOutOfScope: opts.inferDeliveredOutOfScope } : {}),
      ...(opts.claimedItemId !== undefined ? { claimedItemId: opts.claimedItemId } : {}),
    })
  }

  /**
   * Poll-able activity signal for ONE workspace (h2a conductor-launch gating). PURE: `now`/`idleMs`
   * are caller-supplied (track holds no clock). Reads the log ONCE; `pending`/staleness reuse the
   * report logic (`bucketOf`/`effectiveOpenBlockersForItem`) — zero new bucket logic. Read-only.
   */
  workspaceActivity(workspace: string, opts: WorkspaceActivityOptions): WorkspaceActivity {
    const events = this.events()
    const state = fold(events)
    const config = { baselineCommit: opts.baselineCommit, requireAccepted: false }
    const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    const threshold = Date.parse(opts.now) - idleMs // an `at` strictly < this is "durably stuck"

    // Per-aggregate timing from the RAW log (state carries no per-aggregate event timestamps):
    //   creationAt = the aggregate's first event `at`; latestAt = its max event `at`.
    // Also the workspace max `at` (latestEventAt). Aggregate→workspace via the item/decision it names.
    const creationAt = new Map<string, string>()
    const latestAt = new Map<string, string>()
    let latestEventAt: string | undefined
    for (const e of events) {
      if (!creationAt.has(e.aggregateId)) creationAt.set(e.aggregateId, e.at)
      const prev = latestAt.get(e.aggregateId)
      if (prev === undefined || e.at > prev) latestAt.set(e.aggregateId, e.at)
      // Workspace scope of THIS event = the workspace of the item/decision it targets.
      const owner =
        state.items.get(e.aggregateId)?.workspace ?? state.decisions.get(e.aggregateId)?.workspace
      if (owner === workspace && (latestEventAt === undefined || e.at > latestEventAt)) {
        latestEventAt = e.at
      }
    }

    let pending = 0
    const pendingItems: PendingItem[] = []
    // First match wins per aggregate (reasons are listed in priority order); an id appears once.
    const stalled: StalledItem[] = []
    const isOld = (at: string | undefined): at is string => at !== undefined && Date.parse(at) < threshold

    // Demand lifecycle (Mode A, Build 2) — leases for the two new demand-axis stalled reasons. Caller-
    // injected (deterministic) OR read from the side-store; abandonment is computed vs `opts.now`.
    const leases = this.loadLeases(opts.leases)
    const leaseFor = (kind: 'demand' | 'item', id: string): Lease | undefined =>
      leases.find((l) => l.subject.kind === kind && l.subject.id === id)
    const isAbandoned = (lease: Lease | undefined): lease is Lease =>
      lease !== undefined && isLeaseAbandoned(lease, opts.now)

    for (const item of state.items.values()) {
      if (item.workspace !== workspace) continue
      if (isRoleContainer(item)) continue // a WP/spec-phase is a container, never a flat leaf (Scope §B(a))
      const bucket = bucketOf(state, item, config)
      if (bucket === 'TO-DO' || bucket === 'AWAITED') {
        pending++
        pendingItems.push({ id: item.id, title: item.title, bucket, realization: item.realization })
      }

      // (6) spec-abandoned-idle — a PROMOTED (agreed) item with an ABANDONED spec-lease (a silent spec
      // timeout). MORE SPECIFIC than the generic to-do/in-progress idle below ⇒ checked FIRST (first-match-
      // wins): a silently-timed-out spec attempt is the meaningful stall, not "this item is just old". The
      // `since` = the lease `heartbeatAt` (when the silent timeout began).
      if (item.demandId !== undefined && bucket !== 'DONE' && bucket !== 'DROPPED') {
        const lease = leaseFor('item', item.id)
        if (isAbandoned(lease) && isOld(lease.heartbeatAt)) {
          stalled.push({ id: item.id, title: item.title, reason: 'spec-abandoned-idle', since: lease.heartbeatAt })
          continue // exclusive of the generic idle predicates below (first-match-wins)
        }
      }

      if (bucket === 'AWAITED') {
        // (1) awaited-open-blocker — oldest open blocker openedAt drives the staleness.
        const open = effectiveOpenBlockersForItem(state, item.id, config.baselineCommit)
        const oldestOld = open
          .map((b) => b.openedAt)
          .filter((at) => Date.parse(at) < threshold)
          .sort()[0]
        if (oldestOld !== undefined) {
          stalled.push({ id: item.id, title: item.title, reason: 'awaited-open-blocker', since: oldestOld })
        }
        continue // AWAITED is exclusive of the in-progress/todo idle predicates below
      }
      if (item.realization === 'in-progress') {
        // (3) in-progress-idle — no event on this aggregate inside the window.
        const since = latestAt.get(item.id)
        if (isOld(since)) {
          stalled.push({ id: item.id, title: item.title, reason: 'in-progress-idle', since })
        }
      } else if (item.realization === 'to-do') {
        // (4) todo-idle — a TO-DO (no open blocker) whose creation predates the window.
        const since = creationAt.get(item.id)
        if (isOld(since)) {
          stalled.push({ id: item.id, title: item.title, reason: 'todo-idle', since })
        }
      }
    }

    for (const d of state.decisions.values()) {
      if (d.workspace !== workspace) continue
      // (2) pending-decision — outcome still pending/deferred AND last touched before the window.
      if (d.outcome === 'pending' || d.outcome === 'deferred') {
        const since = latestAt.get(d.id)
        if (isOld(since)) {
          stalled.push({ id: d.id, title: d.title, reason: 'pending-decision', since })
        }
      }
    }

    // Demand lifecycle (Mode A, Build 2) — ADDITIVE demand counters + the demand-unqualified-idle reason.
    // Reuses the EXACT stalled machinery (first-match-wins per id, a `since` anchor).
    let raised = 0
    let qualifying = 0
    let agreed = 0
    let hasDemands = false
    for (const demand of state.demands.values()) {
      if (demand.workspace !== workspace) continue
      hasDemands = true
      if (demand.status === 'raised') raised++
      else if (demand.status === 'qualifying') qualifying++
      else if (demand.status === 'agreed') agreed++

      // (5) demand-unqualified-idle — a `qualifying` demand whose lease is ABANDONED (silent timeout) AND
      // whose latest demand-event predates the window. The `since` = the latest demand-axis event `at`.
      if (demand.status === 'qualifying') {
        const lease = leaseFor('demand', demand.id)
        const since = latestAt.get(demand.id)
        if (isAbandoned(lease) && isOld(since)) {
          stalled.push({ id: demand.id, title: demand.raw.title ?? demand.raw.text, reason: 'demand-unqualified-idle', since })
        }
      }
    }

    return {
      workspace,
      pending,
      pendingItems,
      stalled,
      ...(latestEventAt !== undefined ? { latestEventAt } : {}),
      ...(hasDemands ? { demands: { raised, qualifying, agreed } } : {}),
    }
  }

  /** Latest VALID `branch.imported` provenance for `locator`, or `undefined`. */
  branchProvenance(locator: string): BranchProvenance | undefined {
    return this.provenanceFrom(this.events(), locator)
  }

  /** Compare current BRANCH.md `content` against the last imported structure for `locator`. */
  freshness(content: string, locator: string): Freshness {
    return this.freshnessFrom(this.events(), content, locator)
  }

  /**
   * Fail-closed guard for skill consumers (`scope-check`/`lot-gate`): throws `StaleSidecarError`
   * unless the sidecar is FRESH against the given BRANCH.md AND the log integrity is intact.
   * BRANCH.md stays master — a stale or tampered sidecar must NEVER be trusted as the backlog.
   * Reads the log ONCE for both checks.
   */
  requireFresh(content: string, locator: string): void {
    const events = this.events()
    const freshness = this.freshnessFrom(events, content, locator)
    const integrity = validate(events, readHead(this.eventsPath))
    if (freshness.status !== 'fresh' || !integrity.ok) {
      throw new StaleSidecarError(
        `track sidecar unsafe to consume for "${locator}": freshness=${freshness.status}, integrity=${integrity.ok ? 'ok' : 'broken'} — BRANCH.md stays master`,
        { locator, freshness, integrityOk: integrity.ok },
      )
    }
  }

  // ---- internals (single-read helpers) ----

  private provenanceFrom(events: TrackEvent[], locator: string): BranchProvenance | undefined {
    // The LATEST `branch.imported` for the locator is authoritative. Find it regardless of shape,
    // THEN validate its payload. A malformed latest stamp fails CLOSED (→ undefined → `absent` →
    // requireFresh throws); we must NOT fall back to an older valid stamp, or a re-pointed/tampered
    // latest import could read as an earlier "fresh" state even though validate passes.
    let latest: TrackEvent | undefined
    for (const e of events) {
      if (e.type !== 'branch.imported') continue
      if ((e.payload as { locator?: unknown }).locator !== locator) continue
      latest = e
    }
    if (!latest) return undefined
    const p = latest.payload as {
      branchSlug?: unknown
      sourceHash?: unknown
      structureHash?: unknown
    }
    if (typeof p.branchSlug !== 'string' || !isSha256(p.sourceHash) || !isSha256(p.structureHash)) {
      return undefined
    }
    return {
      locator,
      branchSlug: p.branchSlug,
      sourceHash: p.sourceHash,
      structureHash: p.structureHash,
      at: latest.at,
    }
  }

  private freshnessFrom(events: TrackEvent[], content: string, locator: string): Freshness {
    const prov = this.provenanceFrom(events, locator)
    if (!prov) return { status: 'absent' }
    const actual = branchSignature(content) as Sha256
    // Freshness is only AUTHORITATIVE when the content carries a `BR-NN` id — the one identity
    // import and reader provably agree on. Without it, the import's branchSlug may derive from a
    // fileSlug (or title) the reader cannot reproduce, so even an exact structureHash match could be
    // coincidental → fail closed (stale), never fresh.
    if (branchId(content) === undefined || actual !== prov.structureHash) {
      return { status: 'stale', expected: prov.structureHash, actual }
    }
    return { status: 'fresh', structureHash: actual }
  }
}
