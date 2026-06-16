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
import { isRoleContainer, type ItemId } from '../model/item.js'
import type { VerificationRun } from '../model/verification.js'
import { bucketOf } from '../report/buckets.js'
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
import { fold, type State } from '../state/fold.js'
import type { Dossier, Outcome } from '../model/decision.js'
import type { WorkEventKind } from '../ingest/contract.js'
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
export const READ_CONTRACT_VERSION = '1.10.0' // +acceptanceDetail (anchor-freshness read detail) — additive

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

/** Why a workspace item/decision is durably stuck (each reason is one PURE staleness predicate). */
export type StalledReason =
  | 'awaited-open-blocker'
  | 'pending-decision'
  | 'in-progress-idle'
  | 'todo-idle'

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
  /** Items/decisions stuck longer than `idleMs` — the disjunction of the 4 staleness predicates. */
  stalled: StalledItem[]
  /** Max `event.at` scoped to the workspace (informational — h2a corroborates vs live presence). */
  latestEventAt?: string
}

/** Options for {@link TrackReader.workspaceActivity}. `now`/`idleMs` are CALLER-supplied (no clock here). */
export interface WorkspaceActivityOptions {
  baselineCommit: string
  /** ISO-8601 "current" time supplied by the caller — track holds no clock. */
  now: string
  /** Staleness window in ms; default 24h ⇒ "stalled" = DURABLY stuck. */
  idleMs?: number
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
      ...(baseReport.wpTree !== undefined
        ? { wpTree: baseReport.wpTree.filter((n) => state.items.get(n.id)?.workspace === workspace) }
        : {}),
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
    // First match wins per aggregate (reasons are listed in priority order); an id appears once.
    const stalled: StalledItem[] = []
    const isOld = (at: string | undefined): at is string => at !== undefined && Date.parse(at) < threshold

    for (const item of state.items.values()) {
      if (item.workspace !== workspace) continue
      if (isRoleContainer(item)) continue // a WP/spec-phase is a container, never a flat leaf (Scope §B(a))
      const bucket = bucketOf(state, item, config)
      if (bucket === 'TO-DO' || bucket === 'AWAITED') pending++

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

    return {
      workspace,
      pending,
      stalled,
      ...(latestEventAt !== undefined ? { latestEventAt } : {}),
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
