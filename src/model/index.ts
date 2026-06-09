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
  type BlockerScope,
  type BlockerState,
  type ResolutionRule,
} from './blocker.js'
export {
  assertDossierArtifact,
  assertOutcomeTransition,
  isSettled,
  type AddArtifactPayload,
  type ComprehensionEvidence,
  type DecisionCreatedPayload,
  type DecisionKind,
  type DecisionState,
  type Dossier,
  type DossierArtifact,
  type Option,
  type Outcome,
  type QAEntry,
} from './decision.js'
export {
  type AcceptanceStatus,
  type CriterionState,
  type CriterionStatus,
  type EvidenceKind,
  type EvidenceState,
  type RunResult,
  type TestRun,
  type Waiver,
} from './acceptance.js'
export {
  WSJF_SCHEME_VERSION,
  wsjfScore,
  type PriorityAssessment,
  type SchemeId,
  type WsjfInputs,
} from './priority.js'
