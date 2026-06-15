// Public barrel for @sentropic/track. Surfaces grow per lot (events, model, state, report, branch).
export { VERSION } from './version.js'
export * from './events/index.js'
export * from './model/index.js'
export * from './state/index.js'
export * from './accept/index.js'
export * from './report/index.js'
export * from './branch/index.js'
export { Track, type ImportResult, type OpenBlockerInput, type TrackOptions } from './track.js'
export { runCli, type CliIO } from './cli/index.js'
// WP4 — durable, multi-worktree workspace id (pure core + git-I/O resolver), shipped byte-for-byte with h2a.
export { computeDurableWorkspaceId, durableWorkspaceId } from './workspace-id.js'
// Skill-facing, versioned, read-only contract (M2a, Lot v2.0).
export * from './read/index.js'
// harness↔track seam v0 JSON-Schema artifact (FREEZE §9) — the published contract the harness validates
// its emit against + contract-snapshots. Also reachable via the `@sentropic/track/seam` subpath export.
export { SEAM_V0_SCHEMA, SEAM_V0_SCHEMA_VERSION, SEAM_V0_PAYLOAD_DEFS } from './ingest/seam-schema.js'
