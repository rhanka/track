// Acceptance: criterionStatus / acceptanceStatus total cascade, stale vs baselineCommit (SPEC §2.4),
// and `accept run --from` ingestion (SPEC §6).
export { acceptanceStatus, criterionStatus, evidenceForCriterion } from './status.js'
export { parseRunReport, type RunReportEntry, type RunReportFormat } from './ingest.js'
