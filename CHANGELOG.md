# Changelog

All notable changes to `@sentropic/track`. Format loosely follows [Keep a Changelog](https://keepachangelog.com); this package is pre-1.0 (the **event contract** is frozen, but the library/CLI surface may still evolve additively).

## [0.2.0] — M2a "Consumed & exposed" + D3 provenance

### Added
- **Read contract (`@sentropic/track/read`)** — a curated, **versioned** (`READ_CONTRACT_VERSION`), read-only surface for skill consumers: `TrackReader` exposes `report`/`query`/`validate`/`branchProvenance`/`freshness`, plus a **fail-closed `requireFresh`** guard so a stale or tampered sidecar can never become de-facto master over `BRANCH.md`. Freshness is a **structural** signature (per-lot `done`, per-UAT `passed`, BR-id) — no false-stale on prose/reorder edits; the latest stamp is authoritative.
- **Idempotent CI → acceptance ingest** — `accept run --from junit|json` skips a run unless its result differs from the latest for `(evidenceId, commit, env, runner)`, so re-running a commit never multiplies events while genuine flips are recorded. Reusable workflow at `.github/workflows/track-acceptance.yml`.
- **`linked-accepted` dependency blockers** — openness is **derived at report/query time** against `baselineCommit` (revocable: re-opens when the ref regresses), never folded. Strict pass-only.
- **Read-only MCP server** — a second bin, `track-mcp` (stdio): tools `track_report`/`track_query`/`track_validate`/`track_branch_provenance`/`track_freshness`. CLI and MCP share one read command layer ⇒ **byte-identical** output (parity-tested); read tools are side-effect-free.
- **Provenance (`prov`) on events (D3)** — an additive, hash-covered event-core field recording a write's `transport` / `proposed` / `auth` (trust level), separate from `by` (the actor). Forward-compatible with M3/h2a signed identity.
- `validate` desync findings now carry a remediation **`hint`** (still detect-only).

### Changed
- **CLI writes are attributed to the local user** (`by: human:<git-email-or-$USER>`) with `prov:{transport:cli, auth:local-user}`, instead of the reserved `'system'` — so the immutable log honestly distinguishes a human-CLI write from (future) agent writes. `'system'` is now reserved for autonomous/internal events.

### Notes
- The frozen event contract is unchanged in its stream/seq/chain model; `prov` is **additive** (absent on pre-0.2.0 events, which hash identically). MCP **write** tools, multi-writer, h2a coordination and UI remain v2+ (see `docs/plan/PLAN-v2.md`).

## [0.1.0] — MVP
First public release — a record-only system of record with an append-only, integrity-checked event log. Item (spec / realization / acceptance axes), Blockers, first-class Decisions, WSJF prioritization, `report`/`query` buckets, idempotent `BRANCH.md` import, full CLI + library. Node ≥20, ESM. Contract frozen after multi-round adversarial review.
