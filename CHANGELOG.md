# Changelog

All notable changes to `@sentropic/track`. Format loosely follows [Keep a Changelog](https://keepachangelog.com); this package is pre-1.0 (the **event contract** is frozen, but the library/CLI surface may still evolve additively).

## [0.3.0] — M2b write seam: `WorkEvent` ingest (channel ①)

### Added
- **Neutral `WorkEvent` ingest contract + pure mapper** (`@sentropic/track` internals; `INGEST_CONTRACT_VERSION`).
  A transport-agnostic envelope `{v, kind, payload}` maps 1:1 to a Track command; `mapWorkEvent` validates
  fail-closed (unknown major/kind/envelope-key/payload-field, bad type/enum). The CLI's write enums are now
  sourced from this single contract (the CLI's `oneOf` checks and the mapper cannot diverge).
- **`ingest()` with channel-bound authorization.** The WHO/trust come from an `IngestContext` (fixed when
  the channel opens), never the event. Two gates run against freshly-folded state before every write:
  **workspace containment** (the affected aggregate's — and a decision's targets' — workspace must equal
  the channel's; resolved from state, since the payload carries `workspace` only on the two create kinds)
  and a **binding allowlist** (`decision.outcome`, `acceptance.waive`/`run`, `realize→done|cancelled`,
  `blocker.resolve` require `auth ∈ {local-user, signed}` — an unauthenticated channel may only
  create/prepare). MCP stays read-only; the authenticated network channel is deferred to M3.
- **`track ingest <file.jsonl> --workspace <w>`** — a local CLI verb (a local-file adapter like
  `branch import` / `accept run --from`, not a network transport) that applies a WorkEvent stream as the
  local user, stamped `prov.transport:'import'`. Parity-tested **byte-for-byte** against the direct Track
  facade across all 14 kinds incl. `cmdId` batches and go/no-go outcomes.

### Notes
- The frozen event contract is unchanged (no new event types / seq / prevHash / hash); `prov` remains the
  sole provenance carrier. Double-reviewed (`docs/reviews/lot-v2.3b{,-impl}-{codex,opus}.md`).
- **Ingest is at-least-once and non-atomic** in 0.3.0: re-ingesting re-applies create kinds (no dedup) and
  a mid-stream failure leaves earlier events committed. Safe for a human running `track ingest`; a
  **retrying consumer (CI/harness) must dedup upstream**. Idempotency (a reserved envelope key /
  `sourceKey` create dedup) is a prerequisite before any M3 automated-retry channel.

## [0.2.2] — Cross-process write serialization (integrity fix)

### Fixed
- **Concurrent writers could permanently brick the log.** `appendCommand`'s read→validate→compute→append
  critical section had no mutual exclusion: two writers on the same `events.jsonl` (a CLI run while an
  MCP server is live, two processes, a sidecar) computed the same `prevHash`/`seq`, corrupting the
  single stream — after which the fail-closed guard refuses **every** future append (manual repair
  only). Writes are now serialized by an exclusive cross-process lock (`events.jsonl.lock`, kernel-atomic
  `O_EXCL`): **fail-closed, no automatic stealing** (pathname stealing is intrinsically racy), a
  diagnosed timeout (reports the holder and whether it is alive — an orphan from a writer killed
  mid-append is safe to delete, and the message says so), and ownership-token-checked release.
  Double-reviewed (`docs/reviews/lot-v2.3b0-{codex,opus}.md`); contract-neutral (event bytes, hashes,
  `seq`, `head.json` semantics unchanged). Same-host/local-FS scope (NFS out of scope).

### Notes
- Known pre-existing transient (unchanged, detect-only): a reader overlapping a large in-progress append
  can observe a torn trailing line (fail-closed error, not corruption).

## [0.2.1] — Installed-CLI fix

### Fixed
- **`track` CLI did nothing when installed** (global / `npx`). The bin's main-module guard compared `process.argv[1]` — which is the *symlink* an install creates in `bin/` — against the resolved module path, so it never matched and the installed `track` exited 0 without running a command. A dedicated executable entry (`dist/cli/bin.js`) now runs `runCli` unconditionally, the same posture as `track-mcp`. Bug was present since 0.1.0; `track-mcp` was unaffected. Regression-tested by invoking the bin through a symlink.
- **Reported version was `0.0.0`** — `VERSION` (hence the MCP `serverInfo.version`) was a hardcoded constant that never tracked `package.json`. It now reads the manifest, so `track`/`track-mcp` report the real version.

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
