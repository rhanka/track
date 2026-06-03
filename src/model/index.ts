// Domain model: Item, Decision, Blocker, AcceptanceCriterion, PriorityAssessment (SPEC §2).
export {
  DomainError,
  assertRealizationTransition,
  assertSpecTransition,
  type BlockerId,
  type Disposition,
  type Gate,
  type ItemCreatedPayload,
  type ItemId,
  type ItemKind,
  type ItemState,
  type Link,
  type Realization,
  type RealizationCause,
  type SpecStatus,
} from './item.js'
export {
  assertManualResolve,
  type BlockerKind,
  type BlockerOpenedPayload,
  type BlockerState,
  type ResolutionRule,
} from './blocker.js'
export {
  assertOutcomeTransition,
  isSettled,
  type DecisionCreatedPayload,
  type DecisionKind,
  type DecisionState,
  type Dossier,
  type Option,
  type Outcome,
  type QAEntry,
} from './decision.js'
