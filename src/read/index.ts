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
