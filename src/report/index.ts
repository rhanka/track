// report + query: bucket engine with SPEC §7 precedence (AWAITED > DROPPED > DONE > TO-DO).
export { BUCKETS, bucketOf, type Bucket, type ReportConfig } from './buckets.js'
export {
  buildReport,
  query,
  type DecisionRow,
  type QueryFilter,
  type Report,
  type ReportOptions,
  type ReportRow,
} from './build.js'
export {
  formatReport,
  formatRows,
  formatWpConductor,
  formatWpTree,
  wpTotals,
  type Format,
  type WpTotals,
} from './format.js'
// Workpackages §2 — the %-by-WP rollup forest (pure).
export { computeWpTree, tally, type WpLeaf, type WpNode } from './rollup.js'
// Scope §A/§B — status(level) projection (spec|plan|wp|lot|task), additive read-only.
export {
  statusByLevel,
  STATUS_LEVELS,
  type GroupStatus,
  type StatusGroup,
  type StatusLevel,
} from './status-by-level.js'
// Commit-relative blocker openness (v2.2a hybrid-A) — `linked-accepted` derived at projection time.
export { effectiveBlockerOpen, effectiveOpenBlockersForItem } from './blocker-status.js'
