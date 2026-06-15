import type { ItemId } from './item.js'

export type EvidenceKind = 'unit' | 'integration' | 'e2e' | 'manual'
export type RunResult = 'pass' | 'fail'

/** Computed per-criterion status (SPEC §2.4). */
export type CriterionStatus = 'fail' | 'waived' | 'unknown' | 'stale' | 'pass'
/** Computed per-item acceptance (SPEC §2.4). `n/a` for a Decision (no acceptance axis). */
export type AcceptanceStatus = CriterionStatus | 'n/a'

export interface TestRun {
  evidenceId: string
  commit: string
  env: string
  runner: string
  result: RunResult
  at: string
}

export interface Waiver {
  criterionId: string
  reason: string
  by: string
  at: string
}

export interface CriterionState {
  id: string
  itemId: ItemId
  statement: string
  waiver?: Waiver
}

export interface EvidenceState {
  id: string
  criterionId: string
  kind: EvidenceKind
  locator: string
  latestRun?: TestRun
  /**
   * IN-MEMORY DERIVED STATE ONLY (never a persisted event field). The `clientToken` of the delivery that
   * originated this evidence (the `acceptance.evidence.linked` event's `clientToken`), carried by the fold so
   * `linkEvidence`'s caller-supplied-evidenceId collision guard can recognize its OWN concurrent retry (same
   * delivery ⇒ no throw, the under-lock dedup returns the original) versus a DIFFERENT command re-using the id
   * (genuine collision ⇒ throw). Zero contentHash/contract impact (no payload/schema/computeHash change).
   */
  originClientToken?: string
}

export interface CriterionAddedPayload {
  criterionId: string
  itemId: ItemId
  statement: string
}

export interface EvidenceLinkedPayload {
  evidenceId: string
  criterionId: string
  kind: EvidenceKind
  locator: string
}

export interface RunPayload {
  evidenceId: string
  commit: string
  env: string
  runner: string
  result: RunResult
  at: string
}

export interface WaivedPayload {
  criterionId: string
  reason: string
  by: string
  at: string
}
