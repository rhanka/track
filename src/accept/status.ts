import type { AcceptanceStatus, CriterionStatus, EvidenceState } from '../model/acceptance.js'
import type { ItemId } from '../model/item.js'
import type { State } from '../state/fold.js'

export function evidenceForCriterion(state: State, criterionId: string): EvidenceState[] {
  return [...state.evidence.values()].filter((e) => e.criterionId === criterionId)
}

/**
 * Per-criterion status — the SPEC §2.4 ordered cascade over the criterion's evidence
 * (latest run per evidence). A live `fail` overrides a waiver (A6).
 */
export function criterionStatus(
  state: State,
  criterionId: string,
  baselineCommit: string,
): CriterionStatus {
  const criterion = state.criteria.get(criterionId)
  const evidence = evidenceForCriterion(state, criterionId)

  if (evidence.some((e) => e.latestRun?.result === 'fail')) return 'fail' // (1) live fail wins
  if (criterion?.waiver !== undefined) return 'waived' // (2) waiver
  if (evidence.length === 0) return 'unknown' // no evidence and no waiver
  if (evidence.some((e) => e.latestRun === undefined)) return 'unknown' // (3) any evidence no run
  if (evidence.some((e) => e.latestRun!.commit !== baselineCommit)) return 'stale' // (4) not at baseline
  return 'pass' // (5) all evidence latest = pass at baseline
}

/**
 * Per-item acceptance — the SPEC §2.4 ordered cascade over the item's criteria.
 * Zero criteria ⇒ `unknown`. (Decisions have no criteria — `n/a` is structural.)
 */
export function acceptanceStatus(
  state: State,
  itemId: ItemId,
  baselineCommit: string,
): AcceptanceStatus {
  const criteria = [...state.criteria.values()].filter((c) => c.itemId === itemId)
  if (criteria.length === 0) return 'unknown'
  const statuses = criteria.map((c) => criterionStatus(state, c.id, baselineCommit))
  if (statuses.includes('fail')) return 'fail'
  if (statuses.includes('unknown')) return 'unknown'
  if (statuses.includes('stale')) return 'stale'
  if (statuses.includes('waived')) return 'waived'
  return 'pass'
}
