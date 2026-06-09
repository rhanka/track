import { acceptanceStatus } from '../accept/status.js'
import type { ActorId } from '../events/types.js'
import type { AcceptanceStatus } from '../model/acceptance.js'
import type { DecisionKind, Outcome } from '../model/decision.js'
import type { ItemId, ItemKind, ItemRole, ItemState, Realization } from '../model/item.js'
import type { State } from '../state/fold.js'
import { BUCKETS, bucketOf, type Bucket, type ReportConfig } from './buckets.js'
import { computeWpTree, type WpNode } from './rollup.js'

export interface ReportRow {
  id: ItemId
  title: string
  kind: ItemKind
  workspace: string
  bucket: Bucket
  realization: Realization
  acceptance: AcceptanceStatus
  priority?: number
  accountable?: ActorId // RACI-A (Lot A) — surfaced for "who is answerable for this item"
  engagementRef?: string // present ⇒ an h2a contract backs this item
  role?: ItemRole // present ⇒ a workpackage (Workpackages §2) — excluded from the flat buckets
}

export interface DecisionRow {
  id: ItemId
  title: string
  workspace: string
  decisionKind: DecisionKind
  realization: Realization
  outcome: Outcome
  accountable?: ActorId // the decision sponsor (D6)
}

export interface Report {
  buckets: Record<Bucket, ReportRow[]>
  decisions?: DecisionRow[]
  /** Workpackages §2 — the %-by-WP rollup forest. Present iff `ReportOptions.wpTree` (additive, opt-in). */
  wpTree?: WpNode[]
}

export interface ReportOptions {
  baselineCommit: string
  requireAccepted?: boolean
  decisions?: boolean
  /** Include the WP rollup forest on `report.wpTree` (Workpackages §2). Absent ⇒ unchanged behavior. */
  wpTree?: boolean
}

function toRow(state: State, item: ItemState, config: ReportConfig): ReportRow {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    workspace: item.workspace,
    bucket: bucketOf(state, item, config),
    realization: item.realization,
    acceptance: acceptanceStatus(state, item.id, config.baselineCommit),
    ...(item.priority !== undefined ? { priority: item.priority.score } : {}),
    ...(item.accountable !== undefined ? { accountable: item.accountable } : {}),
    ...(item.engagementRef !== undefined ? { engagementRef: item.engagementRef } : {}),
    ...(item.role !== undefined ? { role: item.role } : {}),
  }
}

// Active prioritization scheme: higher score first; un-prioritized items after; stable by id.
function byPriority(a: ReportRow, b: ReportRow): number {
  if (a.priority !== undefined && b.priority !== undefined) {
    return b.priority - a.priority || a.id.localeCompare(b.id)
  }
  if (a.priority !== undefined) return -1
  if (b.priority !== undefined) return 1
  return a.id.localeCompare(b.id)
}

/** Build the bucketed report over non-decision items (SPEC §7). `decisions:true` adds the decision view. */
export function buildReport(state: State, options: ReportOptions): Report {
  const config: ReportConfig = {
    baselineCommit: options.baselineCommit,
    requireAccepted: options.requireAccepted ?? false,
  }
  const buckets: Record<Bucket, ReportRow[]> = { AWAITED: [], DROPPED: [], DONE: [], 'TO-DO': [] }
  for (const item of state.items.values()) {
    // Workpackages §2 — a WP is a container, not a leaf: keep it out of the flat buckets entirely so
    // it can never be mis-counted as a TO-DO leaf (the false-% bug the design warns about). The WP
    // forest is surfaced separately on `report.wpTree`.
    if (item.role === 'workpackage') continue
    const row = toRow(state, item, config)
    buckets[row.bucket].push(row)
  }
  for (const bucket of BUCKETS) buckets[bucket].sort(byPriority)

  const report: Report = { buckets }
  if (options.wpTree) report.wpTree = computeWpTree(state, config)
  if (options.decisions) {
    report.decisions = [...state.decisions.values()].map((d) => ({
      id: d.id,
      title: d.title,
      workspace: d.workspace,
      decisionKind: d.decisionKind,
      realization: d.realization,
      outcome: d.outcome,
      ...(d.accountable !== undefined ? { accountable: d.accountable } : {}),
    }))
  }
  return report
}

export interface QueryFilter {
  // `query` projects the non-decision report rows; filtering by `'decision'` is a compile error
  // (use `report({decisions:true})` for the decision view).
  kind?: Exclude<ItemKind, 'decision'>
  workspace?: string
  bucket?: Bucket
  realization?: Realization
  acceptance?: AcceptanceStatus
  /** Workpackages §2 — select container items. Without it, WP items stay EXCLUDED (unchanged behavior). */
  role?: ItemRole
}

/** Flat, filtered view over the report rows (SPEC §6 `query`). */
export function query(state: State, filter: QueryFilter, options: ReportOptions): ReportRow[] {
  // Source rows in the SAME bucket order as before (each bucket internally priority-sorted) so existing
  // query results are byte-identical. WP containers are excluded from the buckets; a `role` filter
  // reaches them via a separate, priority-sorted projection appended after the bucket rows.
  const report = buildReport(state, options)
  let rows = BUCKETS.flatMap((bucket) => report.buckets[bucket])
  if (filter.role !== undefined) {
    const config: ReportConfig = {
      baselineCommit: options.baselineCommit,
      requireAccepted: options.requireAccepted ?? false,
    }
    const wpRows = [...state.items.values()]
      .filter((i) => i.role !== undefined)
      .map((i) => toRow(state, i, config))
      .sort(byPriority)
    rows = [...rows, ...wpRows]
  }
  return rows.filter(
    (r) =>
      (filter.role === undefined || r.role === filter.role) &&
      (filter.kind === undefined || r.kind === filter.kind) &&
      (filter.workspace === undefined || r.workspace === filter.workspace) &&
      (filter.bucket === undefined || r.bucket === filter.bucket) &&
      (filter.realization === undefined || r.realization === filter.realization) &&
      (filter.acceptance === undefined || r.acceptance === filter.acceptance),
  )
}
