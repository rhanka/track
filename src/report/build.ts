import { acceptanceStatus } from '../accept/status.js'
import type { ActorId } from '../events/types.js'
import type { AcceptanceStatus } from '../model/acceptance.js'
import type { DecisionKind, Outcome } from '../model/decision.js'
import type { ItemId, ItemKind, ItemState, Realization } from '../model/item.js'
import type { State } from '../state/fold.js'
import { BUCKETS, bucketOf, type Bucket, type ReportConfig } from './buckets.js'

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
}

export interface ReportOptions {
  baselineCommit: string
  requireAccepted?: boolean
  decisions?: boolean
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
    const row = toRow(state, item, config)
    buckets[row.bucket].push(row)
  }
  for (const bucket of BUCKETS) buckets[bucket].sort(byPriority)

  const report: Report = { buckets }
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
}

/** Flat, filtered view over the report rows (SPEC §6 `query`). */
export function query(state: State, filter: QueryFilter, options: ReportOptions): ReportRow[] {
  const report = buildReport(state, options)
  const rows = BUCKETS.flatMap((bucket) => report.buckets[bucket])
  return rows.filter(
    (r) =>
      (filter.kind === undefined || r.kind === filter.kind) &&
      (filter.workspace === undefined || r.workspace === filter.workspace) &&
      (filter.bucket === undefined || r.bucket === filter.bucket) &&
      (filter.realization === undefined || r.realization === filter.realization) &&
      (filter.acceptance === undefined || r.acceptance === filter.acceptance),
  )
}
