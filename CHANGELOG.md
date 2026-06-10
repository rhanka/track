# Changelog

All notable changes to `@sentropic/track`. Format loosely follows [Keep a Changelog](https://keepachangelog.com); this package is pre-1.0 (the **event contract** is frozen, but the library/CLI surface may still evolve additively).

## [0.10.10] — WP-under-WP guard + decision sponsor surfaced (D6-B)

### Added / Fixed
- **WP-under-WP invariant** (the deferred 0.10.0 gap): `reparentItem`/`createItem` now reject parenting a
  `role:'workpackage'` item under a non-workpackage (a WP nests only under a WP; a leaf may still nest under a
  WP or a leaf; detach-to-root allowed). Covers the `item.reparent` ingest path (same facade guard).
- **Decision sponsor (D6-B) surfaced end-to-end.** `accountable` already *was* the decision sponsor (M3 Lot A
  superseded the reserved `sponsor` field) and was wired through ingest/CLI/read-JSON; this adds the missing
  human-readable ` · sponsor:<actor>` segment in the `report --decisions` text/md render (present-only).

### Notes
- Additive; no new field, no `READ_CONTRACT_VERSION` bump (sponsor was already on the read surface); event
  contract / write path / P0 guard untouched. 464 tests. Completes WP1's deferred guard + WP5's D6-B.

## [0.10.9] — `propose-workpackages` skill + multi-skill install

### Added
- **`propose-workpackages` skill** (`skills/propose-workpackages/`, tool-neutral) — assembles a flat backlog
  into 4–7 perennial thematic workpackages: cluster by durable concern / owning artifact (down-weighting
  milestone prefixes), one WP per todo (surface homeless, split cross-cutting, never multi-home), preserve
  owner seams (record/render/logic, D5≠M5), then **emit a proposal the human ratifies** (composes
  `present-decision` for consequential restructurings) before applying via `item new --role workpackage` +
  `item reparent`. Verifies with `track report --wp`.
- **`track install-skills` now installs EVERY skill** under `skills/` (discovery), not just one — both
  `present-decision` and `propose-workpackages` deploy to claude/codex/gemini-agy; graceful + idempotent;
  per-skill `AGENTS.md` pointers under one `## Skills` section.

### Notes
- Additive; event contract / write path / P0 guard untouched. 451 tests. Completes WP2 (Reporting & Pilotage).

## [0.10.8] — `--commit HEAD`/ref resolution (acceptance footgun fix)

### Fixed
- **`track report --commit HEAD --require-accepted` now works.** `--commit` (on `report`/`query`/`accept run`/
  `branch import`/`item ls`) is normalized through git at the CLI boundary — `HEAD`, branch names, and short
  SHAs resolve to the full SHA before the (literal) acceptance-freshness compare, so an explicit `--commit
  HEAD` matches a run recorded at that commit (consistent with the no-flag default). A full SHA passes
  through; a non-git dir / bad ref falls back to the literal value (no crash). Reported by a peer conductor
  (graphify) who hit exactly this.

### Notes
- CLI-boundary only — `src/accept/status.ts`'s literal compare (the correctness invariant) is untouched. Event
  contract / write path / P0 guard untouched. 447 tests.

## [0.10.7] — durable workspace-id (h2a-aligned, byte-identical)

### Added
- **`computeDurableWorkspaceId(rootCommitSHA, worktreeRelPath)`** + **`durableWorkspaceId(cwd)`** + the CLI
  **`track workspace-id`** — the PATH- and MACHINE-independent workspace id, **byte-identical to h2a 0.63.0**:
  `'ws:' + sha256hex(rootCommitSHA + '\n' + worktreeRelPath)` (rootCommitSHA = `git rev-list --max-parents=0
  HEAD`, multiple roots sorted+comma-joined; worktreeRelPath = '' for the main worktree else the
  linked-worktree name; non-git → undefined). h2a's published test vectors are pinned as the **conformance
  gate** (green). The same id keys track's `workspaceActivity(...)` poll and h2a's conductor resolver, so the
  same logical repo correlates across cwd moves and local↔remote.

### Notes
- Additive (a derivation helper + CLI; does not yet change how ingest sets `workspace`). Event contract /
  write path / P0 guard untouched. 442 tests.

## [0.10.6] — `track install-skills` (multi-agent skill deploy)

### Added
- **`track install-skills --host <claude|codex|gemini|agy|all> [--scope user|project] [--force]`** — deploys
  the plugin's `present-decision` skill onto the 3 agents on demand (modeled on h2a's installer): claude →
  `~/.claude/skills/`, codex → `~/.codex/skills/` (+ a bounded `AGENTS.md` pointer on `--scope project`),
  gemini/agy → `~/.gemini/commands/present-decision.toml` (translated). Single source = the in-repo `skills/`;
  graceful + idempotent (a differing file is reported and skipped unless `--force`); never creates an absent
  repo entry-point. Completes the multi-agent decision-presentation story.

### Notes
- Additive; event contract / write path / P0 guard untouched. 428 tests.

## [0.10.5] — `present-decision` skill (track plugin) + `decision add-artifact` CLI

### Added
- **`present-decision` skill** (`skills/present-decision/`, tool-neutral) — the **agent→human**
  decision-presentation method: a stakes-calibrated, anti-bias decision dossier with a **self-audit gate**
  (FACT/JUDGMENT tags · count-symmetry on pros · a required "strongest case against my recommendation" ·
  pre-mortem · presenter-interest disclosure), persisted owner criteria, composition with the Codex+Opus
  double-instruction and `track report --wp`, and recording via track. Distinct from h2a (inter-agent
  presenter). Ships in the track plugin (auto-discovered at `<plugin-root>/skills/`); multi-agent install via
  the forthcoming `track install-skills`.
- **`track decision add-artifact <id> --kind …`** CLI — wires the shipped 0.10.3 `decision.add-artifact`
  (fail-closed union; `--client-token` idempotency), so the skill can record a presented decision's artifact.

### Notes
- Additive; event contract / write path / P0 guard untouched. 415 tests.

## [0.10.4] — `workspaceActivity` read (h2a conductor-launch signal)

### Added
- **`TrackReader.workspaceActivity(workspace, {baselineCommit, now, idleMs})`** + the read MCP tool
  **`track_workspace_activity`** — the poll-able signal track promised h2a for conductor-launch gating:
  `{pending, stalled[], latestEventAt}`. `pending` = TO-DO+AWAITED items for the workspace; `stalled` = a
  per-aggregate disjunction of 4 pure predicates (`awaited-open-blocker`, `pending-decision`,
  `in-progress-idle`, `todo-idle`) measured against caller-supplied `now`/`idleMs` (default 24h — track holds
  no clock); `latestEventAt` = workspace max event time. Pure, read-only, side-effect-free.

### Notes
- Additive; `READ_CONTRACT_VERSION` 1.3.0 → 1.4.0. h2a polls + decides + launches (track records + exposes,
  never emits). 410 tests.

## [0.10.3] — Decision-artifact record contract (`Dossier.artifacts[]` + `decision.add-artifact`)

### Added
- **`Dossier.artifacts[]`** — a record-only discriminated-union pointer to an h2a decision dossier
  (`h2a-decision-dossier` {negotiationRef, dossierHash, comprehension[]} | `rendered-view` | `mockup`).
  `ComprehensionEvidence` names the **attester (the decider)** in the payload — distinct from the channel
  `prov.principal` (the relaying bridge) — closing the confused-deputy. Track **records, never verifies**.
- **`decision.add-artifact`** WorkEvent + **`decision.artifact-added`** event — appends one artifact to a
  decision's dossier on its own aggregate (no rewrite; next seq; existing hashes untouched);
  `clientToken`-idempotent; binding-gated (`local-user`/`signed`); workspace-contained; fail-closed union.

### Notes
- Additive; `READ_CONTRACT_VERSION` 1.2.0 → 1.3.0. Pair-reviewed spec
  `docs/plan/M5-decision-presentation-DESIGN.md`. 396 tests. Completes the in-track record side of WP5.

## [0.10.2] — Conductor report: clean `report --wp` (fait / à-faire %·WP / attendus)

### Fixed / Added
- **`track report --wp` is now a clean 3-table conductor view** — **FAIT** (100% WPs + global `done/total,
  pct%`), **À-FAIRE (% par WP)** (per-WP `done/active pct%` + open leaves), **ATTENDUS (décision)** (AWAITED /
  `engagementRef` leaves with a `décision:owner` / `action:agent` disposition). Render fixes: markdown
  escaping no longer leaks into text output; the doubled `WPn · WPn —` label is stripped; `--wp` shows the
  structured view only (no redundant flat-bucket dump). `--wp --format json` emits `wpTree` + global
  `wpTotals`.

### Notes
- `track report` without `--wp` is byte-for-byte unchanged. Additive; event contract / write path / P0 guard
  untouched. TDD; 376 tests.

## [0.10.1] — track-mcp graceful boot (ecosystem launch/serve alignment)

### Fixed
- **`track-mcp` boots unconditionally** (like h2a `mcp-serve`) instead of exiting 1 when no `.track` resolves —
  0.9.0's store-resolver wrongly gated the MCP boot. The store resolves **lazily per read call**
  (`--track-dir`→`TRACK_DIR`→nearest-ancestor), so a `.track` created after boot is served with no restart;
  unresolved reads return honest-empty payloads + a `track init` hint (`isError:false`) and never create a
  store. CLI read commands (`report`/`query`/`validate`) likewise serve empty + a hint (rc=0) when no `.track`.

### Notes
- WRITE-path P0 guard untouched: mutating commands keep fail-loud + `init`-only-creator + the `AppendReceipt`
  verification (`p0-write-loss.test.ts` byte-for-byte unchanged). A bad explicit `--track-dir`/`TRACK_DIR`
  stays loud; a malformed existing log still validates INVALID. Double-reviewed (Codex + Opus pair, converged);
  spec `docs/plan/launch-serve-alignment-FIX.md`. 366 tests.

## [0.10.0] — Workpackage foundation (role + item.reparent + %-rollup)

### Added
- **`role:"workpackage"` marker** (additive optional field) — a workpackage is a parent `Item` marked by
  `role`, never inferred from kind/children. `WP1 → WP1.1 → todo` via `parentId` (arbitrary depth).
- **`item.reparent`** WorkEvent kind + **`item.reparented`** event — re-parent an existing item (set/clear
  `parentId`) on its own aggregate (no recreate; next seq; existing hashes untouched); binding-gated
  (`local-user`/`signed`), self/parent/cross-workspace/**cycle** guarded. Organizes a flat backlog into WPs.
- **`%`-by-WP rollup** (`report --wp`): per WP/sub-WP, `done/active` over transitive non-WP leaves
  (`active = DONE+TO-DO+AWAITED`, DROPPED shown separately), **summed, never mean-of-percentages**,
  `0/0 ⇒ n/a`; dotted display labels (`WP1.1`) derived from tree position; agent-stats-shaped Markdown.
  `query --role`.

### Notes
- All additive — no existing event/hash/seq/bucket/query change; `READ_CONTRACT_VERSION` 1.1.0 → 1.2.0.
  Double-reviewed by the Codex + Opus pair (converged), grounded in a fleet scan (gold precedent: agent-stats);
  spec `docs/plan/workpackages-DESIGN.md`. 352 tests. Known gap: the "a WP's parent must be a WP" guard is
  deferred to the backlog-structuring lot.

## [0.9.0] — P0: silent write-loss guard + store resolver

### Fixed / Changed (record integrity)
- **A write command can no longer return rc=0 without persisting.** `EventStore.appendCommand` now performs a
  post-write **AppendReceipt** verification under the lock (length + suffix `id`/`contentHash` + head +
  full `validate()`); any mismatch throws (CLI → rc=1). Genuine no-ops say "no-op" explicitly. Closes the P0
  where `track item new/realize/spec/accept` could return success while writing nothing.
- **Shared `.track` resolver (CLI + `track-mcp`).** Commands resolve the **nearest-ancestor** `.track`
  (walking up from cwd), with `--track-dir` / `TRACK_DIR` overrides. **`track init` is the only command that
  creates a `.track`**; every other command **fails loud** when none is found — no more stray auto-created
  sidecars from a subdir/worktree cwd.

### Notes
- **Behavior change:** read commands (`report`/`query`/`validate`) and `track-mcp` now require a resolvable
  `.track` and fail loud if absent (previously read/served an empty store). Run `track init` first. Frozen
  event contract intact (additive; the new `TRACK_LOCK_TIMEOUT_MS` is operational-only). Double-reviewed
  (Codex + Opus pair, converged); spec `docs/plan/P0-write-loss-FIX.md`. 330 tests.

## [0.8.0] — Bulk resolve-by-engagementRef (M3 deps follow-up)

### Added
- **`track.resolveExternalDependency(engagementRef, scope)`** + the **`blocker.resolve-external`** WorkEvent
  kind + the CLI verb **`track blocker resolve-external --engagement-ref <e>`** — resolves ALL open external
  (`scope:'extra'`) dependencies referencing an h2a ENGAGEMENT as **one atomic batch**, so a bridge clears
  the N deps of one settled engagement in a single, idempotent call. `scope` is **required and fail-closed**:
  the ingest channel passes `{workspace}` (containment — a pinned channel can never resolve another
  workspace's deps); a local CLI human opts into `'all-workspaces'` explicitly; an unscoped object throws at
  both compile- and run-time.

### Notes
- Additive (a new ingest-contract WorkEvent kind; no new event type — it emits the existing
  `blocker.resolved`, now carrying `engagementRef`; the frozen event contract is intact). Idempotent (a retry
  resolves nothing) and binding (a `signed`/`local-user` channel only). Double-reviewed
  (`docs/reviews/lot-D-resolve-by-engagement-{codex,opus}.md`). Closes the deferred M3 deps follow-up — the
  in-track deps/RACI/contractualization story is now whole.

## [0.7.0] — h2a-bridge read surface (M3 deps/RACI plan complete)

### Added
- **`TrackReader.externalDependencies()`** (read contract → `1.1.0`, additive) + the **`track_external_deps`**
  read-only MCP tool — the open external (`scope:'extra'`) dependencies an h2a bridge watches:
  `[{ blockerId, targetId, engagementRef, openedAt }]`. When an h2a ENGAGEMENT settles, the bridge (a signed
  channel) finds the deps keyed on `engagementRef` and resolves **each** by `blockerId` via a signed
  `blocker.resolve` (admitted because the binding-auth allowlist includes `'signed'`; workspace containment
  still applies). The emitted `blocker.resolved` event now records the `engagementRef` (audit correlation).

### Notes
- Read-only / additive (the read contract only grows; the frozen event contract is untouched apart from the
  additive `engagementRef` audit field on `blocker.resolved`). Double-reviewed
  (`docs/reviews/lot-C-bridge-{codex,opus}.md`). **Completes the M3-deps-raci plan**
  (`docs/plan/M3-deps-raci-DESIGN.md`): deps/RACI + intra/extra dependencies (0.5.0) → signed write channel
  (0.6.0) → bridge read surface (0.7.0). Deferred (tracked, non-blocking): a bulk resolve-by-`engagementRef`
  primitive (one engagement → N items ⇒ N resolves today); the bridge's automated retry should carry a
  `clientToken` (already idempotent) — an untokened double-resolve errors.

## [0.6.0] — M3 signed write channel (library-import)

### Added
- **`prov.auth: 'signed'`** + `transport: 'http'` + optional `principal?` (an NHI id / JWT `sub`) +
  `sig?: {alg, value, by}` on `Provenance` — the M3 authenticated write channel, **shape A
  (library-import)**: a verified caller (the platform API / the h2a bridge, which already verified the OIDC
  JWT or the NHI Ed25519 signature) constructs a signed `IngestContext` and calls the **same** `ingest()`.
  **Track RECORDS the attestation; it never verifies** — record-only and h2a-free (owner-ratified
  semantics). A `signed` channel may perform binding writes (the binding-auth allowlist admits it) and
  **workspace containment still applies** (signed is not a bypass). No network service, no new dependency.

### Notes
- Additive and frozen-contract-neutral (a `Provenance` widening; old events hash byte-identically — the
  proven `prov`/`clientToken` pattern). The recorded `sig` lives inside the hashed core, so a tampered
  attestation surfaces as a `content-hash` finding; the prov snapshot deep-clones the nested `sig`
  (`structuredClone`), preserving D3's inert-snapshot guarantee. The CLI is unchanged — signed contexts are
  built programmatically by the verified caller. Double-reviewed (`docs/reviews/lot-B-m3-{codex,opus}.md`,
  both SHIP). The h2a bridge (automated `extra`-dep resolution) is the next lot.

## [0.5.0] — Dependencies, RACI & contractualization handle (M3 prelude, Lot A)

### Added
- **RACI fields** (additive): `accountable?` (RACI-A — the answerable owner) and `responsible?` (RACI-R —
  the doers) on Items; `accountable?` on Decisions, where it **is the decision sponsor** (resolves D6 —
  supersedes the reserved separate `sponsor` field). Surfaced in fold + report rows.
- **Intra- vs extra-repo dependency blockers.** A `dependency` blocker now carries an optional
  `scope: 'intra' | 'extra'`. `intra` (the default — implicit, byte-unchanged) keeps the local-`ref`
  invariant. `extra` expresses a **cross-repo/cross-agent** dependency: it omits the local `ref`, requires
  an opaque **`engagementRef`** (an h2a ENGAGEMENT id), and resolves `manual` only — track records the
  external dependency but never reads or coordinates h2a's state.
- **`engagementRef?`** on Items, Decisions, and Blockers — the link to an h2a executable contract; present
  ⇒ a contract backs this record. The boundary stays clean: **track owns the record; h2a owns the
  contract** (charter / negotiation / signatures).
- All of the above flow through the CLI (`item new`/`decision new`/`blocker raise` flags) and the neutral
  `WorkEvent` ingest contract.

### Notes
- Additive and frozen-contract-neutral (payload/enum-only on existing event types; old events hash
  byte-identically — the proven `prov`/`clientToken` pattern). A new fail-closed `validate` finding
  (`blocker-scope`) enforces the dependency-scope invariant on the log, so a self-consistent but illegal
  blocker (from a future writer or a direct append) cannot fold into a foreign-`ref` dereference.
- Double-reviewed (`docs/reviews/lot-A-deps-raci-{codex,opus}.md`). Design + boundary:
  `docs/plan/M3-deps-raci-DESIGN.md`. **M3** (the authenticated server-to-server write channel, signed
  `prov.auth`) and the **h2a bridge** (automated `extra`-dep resolution) are subsequent lots.

## [0.4.0] — Ingest idempotency (`clientToken`)

### Added
- **Opt-in delivery idempotency for `ingest`.** A `WorkEvent` may carry an optional `clientToken`; ingest
  stamps it (additive, hash-covered) onto every event it emits and **skips** a WorkEvent whose token is
  already in the log — returning the **original** assigned id. A retry of a partial or duplicate stream is
  then a safe no-op with stable ids: creates don't duplicate, transition replays don't throw, criterion/
  link/assess don't re-append. Without a token, the prior at-least-once behavior is unchanged (the human
  `track ingest` path is untouched). The token namespace is **scoped per workspace**, so a token used in
  one workspace can never suppress or alias a write in another.

### Notes
- `EventCore.clientToken` is additive and hash-covered exactly like `prov` (0.2.0): events without it hash
  byte-identically, no event type / `seq` / `prevHash` / chain change, fold unchanged. Double-reviewed
  (`docs/reviews/lot-v2.3c-impl-{codex,opus}.md`).
- **Deferred to M3** (documented): the concurrent-retry race (two *parallel* ingests both seeing the token
  absent before either commits) needs an in-`appendCommand` token recheck under the existing write lock,
  plus the authenticated channel's request-level idempotency; token-reuse-conflict detection (same token,
  different content) and whole-file atomicity are likewise deferred.

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
