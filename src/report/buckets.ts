import { acceptanceStatus } from '../accept/status.js'
import type { ItemState } from '../model/item.js'
import { openBlockersForItem, type State } from '../state/fold.js'

export type Bucket = 'AWAITED' | 'DROPPED' | 'DONE' | 'TO-DO'
export const BUCKETS: readonly Bucket[] = ['AWAITED', 'DROPPED', 'DONE', 'TO-DO']

export interface ReportConfig {
  /** The "current" commit for staleness (SPEC §2.4); CLI default = repo git HEAD. */
  baselineCommit: string
  /** When true, a `done` item only counts as DONE if acceptanceStatus=pass (SPEC §7.3, default false). */
  requireAccepted: boolean
}

/**
 * Place a non-decision item in a bucket — SPEC §7, first match wins:
 * AWAITED (any open blocker) > DROPPED (cancelled/rejected) > DONE (done, and accepted if
 * required) > TO-DO. A `done` item with an open blocker is AWAITED (precedence), and a `done`
 * item that is not yet accepted (under requireAccepted) falls through to TO-DO.
 */
export function bucketOf(state: State, item: ItemState, config: ReportConfig): Bucket {
  if (openBlockersForItem(state, item.id).length > 0) return 'AWAITED'
  if (item.realization === 'cancelled' || item.realization === 'rejected') return 'DROPPED'
  if (item.realization === 'done') {
    if (
      config.requireAccepted &&
      acceptanceStatus(state, item.id, config.baselineCommit) !== 'pass'
    ) {
      return 'TO-DO'
    }
    return 'DONE'
  }
  return 'TO-DO'
}
