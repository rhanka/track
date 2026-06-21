// Read contract barrel (Lot v2.0) — the skill-facing, versioned, read-only surface.
export {
  READ_CONTRACT_VERSION,
  StaleSidecarError,
  TrackReader,
  type AmendmentOrigin,
  type AmendmentProv,
  type AmendmentStep,
  type BranchProvenance,
  type CanevasOptions,
  type CanevasView,
  type Cursor,
  type CursorDelta,
  type DecisionDossierView,
  type ExternalDependency,
  type Freshness,
  type GraphExportOptions,
  type ProvLineage,
  type StalledItem,
  type StalledReason,
  type WorkspaceActivity,
  type WorkspaceActivityOptions,
} from './contract.js'
export {
  type TrackGraphEdge,
  type TrackGraphFragment,
  type TrackGraphNode,
  type TrackGraphProvenance,
} from '../graph-export.js'
// Scope §A/§B — projection/evidence types re-exported for skill consumers of the read contract.
export { type GroupStatus, type StatusGroup, type StatusLevel } from '../report/status-by-level.js'
export { type VerificationRun, type Verdict } from '../model/verification.js'
// Scope §B(b) — the advisory scope-validate read surface.
export {
  type EvidenceStatus,
  type PerWp,
  type ScopeFinding,
  type ScopeFindingCode,
  type ScopeValidateInput,
  type ScopeValidateResult,
  type ScopeValidateStatus,
  type SemanticStatus,
} from './scope-validate.js'
// Self-contained /read (1.11.0, additive) — the foundational/model types NAMED in the public shapes of the
// read-contract interfaces above, so a versioned consumer (Focus-M1 L2) binds against `/read` ALONE without
// reaching into the unversioned main `@sentropic/track` barrel. Pure type re-exports — no value, no logic.
// from ../model/decision.js — Dossier (DecisionDossierView.dossier) + its constituents (Option/QAEntry on
//   Dossier.{options,qa}; DossierArtifact on Dossier.artifacts; ComprehensionEvidence on a DossierArtifact)
//   and Outcome (DecisionDossierView.outcome / decision affordances).
export {
  type ComprehensionEvidence,
  type Dossier,
  type DossierArtifact,
  type Option,
  type Outcome,
  type QAEntry,
} from '../model/decision.js'
// from ../model/priority.js — PriorityAssessment (Dossier.decisionEvaluation — the frozen priority snapshot).
export { type PriorityAssessment } from '../model/priority.js'
// from ../model/item.js — ItemId (DecisionDossierView.id, CanevasOptions.decisionId, StalledItem.id, the
//   amendmentTrace/verificationRuns/acceptanceDetail parameters).
export { type ItemId } from '../model/item.js'
// from ../events/types.js — ActorId (AmendmentStep.by), EventType (AmendmentStep.kind / the amendment event
//   kinds), Provenance (AmendmentProv.auth / ProvLineage.auth = Provenance['auth']), Sha256 (Cursor.head,
//   Freshness, BranchProvenance.{sourceHash,structureHash}).
export { type ActorId, type EventType, type Provenance, type Sha256 } from '../events/types.js'
