import { DomainError, type ItemId } from './item.js'

export type SchemeId = 'wsjf'

/** A versioned, append-only priority assessment (SPEC §2.8). Item.priority = the latest one. */
export interface PriorityAssessment {
  itemId: ItemId
  schemeId: SchemeId
  schemeVersion: number
  inputs: Record<string, number>
  score: number
  order?: number
  at: string
}

export interface WsjfInputs {
  userBusinessValue: number
  timeCriticality: number
  riskReductionOpportunityEnablement: number
  jobSize: number
}

export const WSJF_SCHEME_VERSION = 1

/** WSJF (SPEC §2.8): (UBV + TC + RR/OE) / jobSize. Never hardcoded; used only when active. */
export function wsjfScore(inputs: WsjfInputs): number {
  if (!(inputs.jobSize > 0)) {
    throw new DomainError('WSJF jobSize must be > 0')
  }
  return (
    (inputs.userBusinessValue +
      inputs.timeCriticality +
      inputs.riskReductionOpportunityEnablement) /
    inputs.jobSize
  )
}
