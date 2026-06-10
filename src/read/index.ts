// Read contract barrel (Lot v2.0) — the skill-facing, versioned, read-only surface.
export {
  READ_CONTRACT_VERSION,
  StaleSidecarError,
  TrackReader,
  type BranchProvenance,
  type ExternalDependency,
  type Freshness,
  type StalledItem,
  type StalledReason,
  type WorkspaceActivity,
  type WorkspaceActivityOptions,
} from './contract.js'
// Scope §A/§B — projection/evidence types re-exported for skill consumers of the read contract.
export { type GroupStatus, type StatusGroup, type StatusLevel } from '../report/status-by-level.js'
export { type VerificationRun, type Verdict } from '../model/verification.js'
