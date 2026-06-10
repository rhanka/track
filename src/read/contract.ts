// Lot v2.0 — curated, VERSIONED read contract (PLAN-v2 M2a).
//
// The MVP barrel (`src/index.ts`) still `export *`s internals; that is the LIBRARY surface. THIS
// module is the *skill-facing read contract* (`scope-check` / `lot-gate` consume it via the
// `@sentropic/track/read` subpath) — reads only (report / query / validate / branch provenance /
// freshness), never mutations, plus a fail-closed `requireFresh` guard so a stale OR tampered
// sidecar can never become de-facto master over BRANCH.md (the source of truth — SPEC §5,
// INTENTION §9 pin).

import { branchId } from '../branch/parse.js'
import { branchSignature } from '../branch/signature.js'
import { readHead } from '../events/head.js'
import { EventStore } from '../events/store.js'
import type { Sha256, TrackEvent } from '../events/types.js'
import { validate, type IntegrityResult } from '../events/validate.js'
import type { ItemId } from '../model/item.js'
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
import { fold } from '../state/fold.js'

/**
 * Semver of the skill-facing READ contract.
 *
 * **Policy (PLAN-v2 D7 — additive-only):** within a major, the `TrackReader` surface and the
 * shapes it returns may only GROW (new methods / new optional fields); nothing is removed or
 * repurposed without a major bump. Consumers gate on `reader.contractVersion`.
 */
export const READ_CONTRACT_VERSION = '1.5.0' // +verificationRuns() evidence read + statusByLevel() projection (Scope §A/§B, additive)

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
      if (item.role === 'workpackage') continue // a WP is a container, never a flat leaf (Workpackages §2)
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
