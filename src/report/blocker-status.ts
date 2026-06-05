// Lot v2.2b — commit-relative ("hybrid-A") blocker openness for the `linked-accepted` rule.
//
// `fold()` is baseline-free, so it cannot evaluate acceptance (which is a function of
// (state, baselineCommit) and is REVOCABLE). It therefore folds a `linked-accepted` blocker as
// conservatively OPEN (never falsely closed). The AUTHORITATIVE openness is DERIVED HERE, at
// report/query time, against the caller's `baselineCommit` — so a `linked-accepted` gate closes
// only while its ref is accepted and RE-OPENS for free (no event) when the ref regresses.
// Never call this from `fold` — it would pin the commit axis and break determinism.
//
// Settle-once rules (`decision`, `manual`, `linked-done`) keep their fold-scalar `blocker.open`.
// Decision blockers ("blocked until a decision settles") are already covered by `kind:"decision"`
// + the go/no-go batch that resolves them (`resolvedByEvent`), so no separate `decision-settled`
// dependency rule is introduced here (see docs/plan/v2.2a-linked-accepted-DESIGN.md §4).

import { acceptanceStatus } from '../accept/status.js'
import type { AcceptanceStatus } from '../model/acceptance.js'
import type { BlockerState } from '../model/blocker.js'
import type { ItemId } from '../model/item.js'
import type { State } from '../state/fold.js'

/** Acceptance statuses that CLOSE a `linked-accepted` gate — strict pass-only (owner policy P3). */
const ACCEPTED_CLOSES: ReadonlySet<AcceptanceStatus> = new Set<AcceptanceStatus>(['pass'])

/**
 * Authoritative openness of a blocker at a given `baselineCommit`. `resolvedByEvent` hard-closes
 * first (manual/decision). For `linked-accepted` (dependency), openness = ref is not accepted at
 * the baseline (revocable). All other rules fall back to the fold scalar `blocker.open`.
 */
export function effectiveBlockerOpen(
  state: State,
  blocker: BlockerState,
  baselineCommit: string,
): boolean {
  if (blocker.resolvedByEvent) return false
  if (blocker.kind === 'dependency' && blocker.resolutionRule === 'linked-accepted') {
    return !ACCEPTED_CLOSES.has(acceptanceStatus(state, blocker.ref, baselineCommit))
  }
  return blocker.open
}

/** Open blockers targeting `itemId`, evaluated against `baselineCommit` (commit-relative). */
export function effectiveOpenBlockersForItem(
  state: State,
  itemId: ItemId,
  baselineCommit: string,
): BlockerState[] {
  return [...state.blockers.values()].filter(
    (b) => b.targetId === itemId && effectiveBlockerOpen(state, b, baselineCommit),
  )
}
