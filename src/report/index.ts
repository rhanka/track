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
export { formatReport, formatRows, type Format } from './format.js'
// Commit-relative blocker openness (v2.2a hybrid-A) — `linked-accepted` derived at projection time.
export { effectiveBlockerOpen, effectiveOpenBlockersForItem } from './blocker-status.js'
