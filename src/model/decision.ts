import {
  DomainError,
  type Gate,
  type ItemId,
  type Link,
  type Realization,
} from './item.js'

export type DecisionKind = Gate // a Decision's kind == the gate it settles (SPEC §2.10)
export type Outcome = 'pending' | 'go' | 'no-go' | 'deferred'

export interface Option {
  id: string
  title: string
  summary: string
  pros?: string[]
  cons?: string[]
}

export interface QAEntry {
  id: string
  question: string
  answer?: string
}

/** Typed decision dossier (SPEC §2.7). `outcome` is NOT duplicated here (single source = the Decision). */
export interface Dossier {
  context: string
  options: Option[]
  qa: QAEntry[]
  selectedOptionId?: string
  recommendation?: { optionId: string; rationale: string }
  resultingSpecChange?: string
  decisionEvaluation?: unknown // FROZEN PriorityAssessment snapshot (typed in Lot 4b)
}

/** A Decision is a specialized Item (kind:"decision"): only realization (its prep) + outcome (SPEC §2.5). */
export interface DecisionState {
  id: ItemId
  kind: 'decision'
  title: string
  workspace: string
  realization: Realization
  decisionKind: DecisionKind
  targets: ItemId[]
  outcome: Outcome
  dossier: Dossier
  parentId?: ItemId
  sourceKey?: string
  body?: string
  links?: Link[]
}

export interface DecisionCreatedPayload {
  decisionKind: DecisionKind
  title: string
  workspace: string
  targets: ItemId[]
  dossier: Dossier
  parentId?: ItemId
  sourceKey?: string
  body?: string
  links?: Link[]
}

// outcome machine (SPEC §2.6): pending → {go,no-go,deferred}; deferred → {go,no-go}; go/no-go terminal.
const OUTCOME_TRANSITIONS: Record<Outcome, ReadonlyArray<Outcome>> = {
  pending: ['go', 'no-go', 'deferred'],
  deferred: ['go', 'no-go'],
  go: [],
  'no-go': [],
}

export function assertOutcomeTransition(current: Outcome, to: Outcome): void {
  if (!OUTCOME_TRANSITIONS[current].includes(to)) {
    throw new DomainError(`illegal outcome transition ${current} -> ${to}`)
  }
}

export function isSettled(outcome: Outcome): boolean {
  return outcome === 'go' || outcome === 'no-go'
}
