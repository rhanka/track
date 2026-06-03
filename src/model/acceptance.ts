import type { ItemId } from './item.js'

export type EvidenceKind = 'unit' | 'integration' | 'e2e' | 'manual'
export type RunResult = 'pass' | 'fail'

/** Computed per-criterion status (SPEC §2.4). */
export type CriterionStatus = 'fail' | 'waived' | 'unknown' | 'stale' | 'pass'
/** Computed per-item acceptance (SPEC §2.4). `n/a` is structural (decisions have no criteria). */
export type AcceptanceStatus = CriterionStatus

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
