# Changelog

All notable changes to `@sentropic/track`. Format loosely follows [Keep a Changelog](https://keepachangelog.com); this package is pre-1.0 (the **event contract** is frozen, but the library/CLI surface may still evolve additively).

## [0.23.0] — merge-loss containment gate (`events-contains`) + `branch-lifecycle` skill

Protects track's append-only event log from merge-time loss (the graphify incident: a squash-merge dropped
18 committed reparent events). The gate is **event-id CONTAINMENT**, never "squash vs merge-commit" (the
wrong predicate — too weak AND too strong). Double consensus (Codex 5.5xhigh + Opus 4.8max): design
AMEND→locked, implementation gate CHANGES_REQUIRED→**scope split** (the `.gitattributes merge=union`
auto-reconcile is DEFERRED, paired with a future `reseal` verb — a union-merged log keeps every event but
breaks the positional hash-chain, so it is read-recoverable yet not re-appendable until re-chained; shipping
union without reseal would freeze writes). The containment gate ships now and is the real protection.

### Added
- **`track events-contains --base <log> --candidate <log> [--format json|text]`** — a pure, git-free,
  store-free containment primitive over the STABLE event `id` set. `rc=0` candidate ⊇ base (no loss);
  `rc=1` ≥1 base id missing (loss — ids listed); `rc=2` cannot evaluate (bad flag / missing / malformed
  log) — kept DISTINCT so a CI gate tells a real loss from a setup error and a typo'd `--base` is never a
  vacuous pass. Compares `id` (not `contentHash`) so it survives a future re-seal.
- **`branch-lifecycle` skill (ships via `install-skills`).** Detect-and-GUIDE, record-only, never
  auto-repairs. Judges git ancestry in the shell; detects structural loss via `events-contains` (NOT
  `audit.orphan`, which is blind to a reparent lost toward a valid parent); recovers OPPORTUNISTICALLY from
  a surviving ref/reflog before declaring anything irrecoverable; re-anchors acceptance via
  `report --require-accepted` + `consolidate`, then RE-READS to surface done-but-skipped. Bundled
  `assets/check.sh` is a CI wrapper doing a real git trial-merge and failing closed on non-containment.

### Contract
- No event, no `READ`/`INGEST` bump (READ stays **1.16.0**): `events-contains` is a util CLI over explicit
  file paths, outside the `TrackReader`/read-projection surface. `consolidate`/`restructure apply`/`audit`
  unchanged.

## [0.22.1] — CLI: `track item assign-code`

Exposes the A1 stable-code write on the CLI (the canonical write was facade/event-only in 0.22.0):
`track item assign-code <itemId> --code <c> [--client-token <t>]` calls `assignCode` (roster-global
uniqueness re-asserted under lock; `--client-token` append-once idempotent). Pure CLI surface — no contract
change (INGEST 1.5.0 / READ 1.16.0 unchanged).

## [0.22.0] — stable workpackage codes (sub-lot A1)

Gives a workpackage (or spec-phase) a **durable, re-assignable display `code`** that DECOUPLES stability from
the derived `WP<n>` numbering: the report renders the code verbatim, while the positional counter SKIPS any
ordinal a `^WP\d+$` code claims — so a roster reads the same labels even as items are added or reordered. A
code is a **display label, never an identity** (`wpRootId`/`wpRef`/objective-refs stay ULID). Double consensus
(Codex 5.5xhigh + Opus 4.8max): design AMEND→locked, implementation gate SHIP_WITH_NITS (the flagged sub-WP
asymmetry nit is folded into this release). All additive; a no-code roster renders **byte-identical** to the
pre-codes output.

### Added
- **`item.assign-code` → `item.code-assigned` event (LWW, `settles:'always'`).** A new additive event on the
  EXISTING item aggregate (next seq, no recreate; existing hashes untouched), mirroring `scope.declare`. Fold
  takes the last value (a code is corrigible WITH TRACE — it never changes on its own). Old readers ignore it
  (fail-safe; a container never enters a flat bucket — display-only).
- **`assignCode(itemId, code, clientToken?)` facade.** Guards fail-closed BEFORE any append: the item exists;
  it is `role ∈ {workpackage, spec-phase}`; the code is a non-empty string; and **roster-global uniqueness** —
  no OTHER coded role-container (root OR nested sub-WP, across the whole forest) already holds the code. The
  uniqueness scan is NON-PURE (it folds global state), so it is RE-ASSERTED UNDER THE LOCK (F2) — a racing
  second writer that saw a stale pre-lock state is rejected rather than appending a colliding code. Binding-
  gated (`settles:'always'`) + workspace-contained at the ingest seam; `clientToken`-idempotent.
- **Report label = code, else derived `WP<n>` skipping claimed ordinals.** `computeWpTree` renders a coded
  container's label verbatim; an uncoded root takes the next `WP<n>` whose ordinal is NOT claimed by a
  `^WP\d+$` code on ANY coded container (root or sub-WP — the same display class). A no-code roster = `WP1..WPN`
  byte-identical; an all-coded roster = its codes exactly; a mixed roster = codes + `WP<n>` filling the gaps
  WITHOUT collision. `WpNode.code` is surfaced drop-when-absent. Codes are display labels only — the node `id`
  stays the ULID, and `wpRootId` is unchanged by a recode.

### Contract
- **INGEST 1.4.0 → 1.5.0** (additive: `item.assign-code` kind / `item.code-assigned` event). **READ 1.15.0 →
  1.16.0** (additive: the `WpNode.code` field). No event removed/renamed; old readers ignore the new kind and
  field (fail-safe).

## [0.21.0] — cross-workspace workpackage reorganization (intra-repo) + `track audit`

Decouples the **workpackage tree** (`parentId`) from the immutable `workspace` field, so a workpackage can
group items across workspaces **within one repo** without changing their workspace — append-only, no history
loss. Double consensus (Codex 5.5xhigh + Opus 4.8max): design AMEND→locked, implementation gate SHIP. All
additive; `report`/`canevas` semantics for mono-workspace trees are byte-identical.

### Added
- **Cross-workspace restructuring capability (record-only, fail-closed).** A NEW default-denied ingest kind
  `item.restructure` (mapped to the existing `item.reparented` event) is the ONLY way to reparent across
  workspaces. Authorized by an explicit context-level grant (`ctx.allowedKinds`) the ordinary channels never
  hold — never by a payload flag. The deny is explicit in `authorize` (it fails closed even when
  `allowedKinds` is unset). The child stays pinned to its channel workspace; only the parent may differ.
  Ordinary `item reparent` remains strictly intra-workspace (the guard is unconditional).
- **`track restructure apply --plan <plan.json>`** — apply a RATIFIED `{itemId→parentId}` plan. `planHash`
  content-addresses the complete edge map; `clientToken = f(planHash,itemId)` makes a replay a no-op. MANDATORY
  baseline (`streamLength`+`lastContentHash`) anti-TOCTOU; a FULL dry-run of every edge (self/role-nesting/cycle
  over the prospective graph) runs BEFORE any append (atomic: nothing is written on a bad plan). Post-apply
  GATE: intention per edge, exact-token closure (token≡aggregate), zero out-of-plan orphan.
- **`track audit [--format json|text]`** — deterministic structural findings (`orphan`, `empty-wp`,
  `duplicate`, `cross-workspace-subtree`, `singleton-workspace`); read-only, no fuzzy heuristics. MCP parity:
  the `track_audit` read tool is byte-identical to the CLI JSON.
- **`wpRootId`** derivation (topmost `role:'workpackage'` ancestor) and a defensive **leaf-clip** for the
  workspace-scoped canevas (a cross-workspace subtree no longer leaks foreign leaves or drops in-workspace
  ones; the rollup is marked `partial`).

### Contract
- **INGEST 1.3.0 → 1.4.0** (additive: `item.restructure` kind). **READ 1.14.0 → 1.15.0** (additive: `audit`,
  the `WpNode.partial` field). No event removed/renamed; old readers ignore the new kind (fail-safe).

## [0.17.0] — self-contained `@sentropic/track/read` (Focus-M1 L2 versioned binding)

### Added
- **`@sentropic/track/read` is now self-contained (purely additive).** The versioned read subpath
  re-exports every foundational/model type NAMED in the public shape of a `/read`-exported interface, so a
  consumer (Focus-M1 L2) can bind against `@sentropic/track/read` ALONE — without reaching into the
  unversioned main `@sentropic/track` barrel's `export *` library surface. New **type-only** re-exports
  (`export type { … }`, no value/runtime change):
  - from `../model/decision.js` — `Dossier`, `Outcome`, `Option`, `QAEntry`, `DossierArtifact`,
    `ComprehensionEvidence` (the `DecisionDossierView.dossier`/`outcome` closure).
  - from `../model/priority.js` — `PriorityAssessment` (`Dossier.decisionEvaluation`).
  - from `../model/item.js` — `ItemId` (`DecisionDossierView.id`, `CanevasOptions.decisionId`, `StalledItem.id`,
    the `amendmentTrace`/`verificationRuns`/`acceptanceDetail` parameters).
  - from `../events/types.js` — `ActorId` (`AmendmentStep.by`), `EventType` (`AmendmentStep.kind`),
    `Provenance` (`AmendmentProv.auth` / `ProvLineage.auth`), `Sha256` (`Cursor.head`, `Freshness`,
    `BranchProvenance`).

### Notes
- **Frozen event contract intact — no wire/logic change.** `READ_CONTRACT_VERSION` bumps `1.10.0` → `1.11.0`
  (additive-only: the read surface only GROWS). `INGEST_CONTRACT_VERSION` is unchanged. Existing exports are
  not removed, renamed, or reordered; this is a pure additive re-export lot guarded by
  `src/read/read-self-contained.test.ts` (typecheck is the real gate).

## [0.16.0] — harness↔track seam v0 cross-contract drift-gate (BR-H1 atomic pair)

### Added
- **Cross-contract drift-gate** (`src/ingest/seam-harness-parity.test.ts`) — pins the harness-emitted
  `VerificationRun` schema (frozen by harness PR #343, `@sentropic/harness@0.3.0`) against track's
  `SEAM_V0_SCHEMA` agreement-mirror. The harness schema is vendored byte-identically at
  `src/ingest/__fixtures__/harness-verification-run.schema.json` (+ a provenance `README.md`) and **pinned by
  SHA-256**, so any upstream schema change surfaces as a reviewable fixture diff. The gate compares **normalized
  projections** (enum arrays, `required` arrays, property-name sets) across the layer boundary — harness root +
  `definitions` ↔ track mirror `$defs` + shared enum `$defs` — never a whole-document equality and never against
  the post-projection wire payloads. This is track's half of the BR-H1 **atomic PR pair** (lands with harness #343).

### Changed
- **Mirror realigned to the frozen harness schema (ratified, non-breaking loosening).** The published
  `SEAM_V0_SCHEMA` agreement-mirror `$defs` are relaxed so the two contracts agree byte-for-byte on shape:
  - `$defs.VerificationCheck.required` drops `target` (D1) — a target-less check is legal producer-side; the
    adapter still FAILS CLOSED on a track-ingested check with no target (`target` stays an optional property).
  - `$defs.Violation.required` drops `path` (D2) — `path` is present only when the violation is path-scoped;
    the deterministic `JSON.stringify({severity,code,path,message})` projection OMITs it when absent (never
    empty-string fill).
  - `$defs.VerificationRun.runId` description corrected (M1) to the PHYSICAL per-invocation id (matching harness);
    the per-emitted-verdict PROJECTION id is adapter-minted and lives on `ScopeVerificationPayload.runId`.
  These `$defs` are NOT used by track's runtime validation (the wire is enforced by `WORK_EVENT_SCHEMA` +
  `assertVerificationRun`), so the relaxation has zero runtime effect — it re-aligns the published agreement
  artifact only. Loosening `required` is non-breaking: any document valid under the old mirror stays valid.

### Notes
- **Frozen event contract intact — no wire/read change.** `INGEST_CONTRACT_VERSION` stays `1.2.0`,
  `READ_CONTRACT_VERSION` unchanged. The pair-review (Codex 5.5xhigh + Opus 4.8max, both SHIP, mutation-tested
  gate) is archived at `docs/reviews/brh1-cross-snapshot-SYNTHESIS.md` + `docs/reviews/brh1-build-FINAL.md`.
- **Deferred follow-on (flagged, non-blocking):** the seam-wire hardening (REQUIRE `artifactLocator` on
  `scope.verification` + `evidenceId` on `acceptance.link` for SEAM-SOURCED events only) is NOT in this lot —
  the single `ingest()` path has no seam-source discriminator, and an unconditional tightening would break the
  legacy/CLI back-compat. Clean path recorded: an optional `seamSourced?` marker on `IngestContext`, gated
  per-path, landing with the full `VerificationRun → violations[]` ingestion adapter (where the D2 OMIT rule
  becomes executable, not documentation-only).

## [0.15.0] — `@sentropic/track/ingest` submit export for the in-process M5 host

### Added
- **`@sentropic/track/ingest` package export** — a curated, additive SUBMIT-facing barrel (`src/ingest/index.ts`)
  that lets an IN-PROCESS host import the write seam through a stable subpath. It re-exports exactly what a host
  needs to construct + submit a `WorkEvent` and read the receipt: `ingest`, the `IngestContext` + `IngestResult`
  (receipt) types, the `WorkEvent`/`WorkEventKind` types, `INGEST_CONTRACT_VERSION`, `BINDING_AUTH`, and the
  `IngestError` a caller must catch. Curated like `./read` (a deliberate, documented contract — not `export *`);
  re-exports from the existing modules, no logic duplicated. `BINDING_AUTH` is now exported from `src/ingest/ingest.ts`
  (was module-private) so a host can pre-check whether its channel `prov.auth` admits binding writes.
- **This unblocks the M5 canevas host's submit channel.** Owner-ratified "submit = A" (M3-channel-DESIGN.md /
  M5-canevas-HOST-INTEGRATION-DESIGN.md §5): the host imports `ingest()` in-process and CARRIES AUTH via the
  `IngestContext` (WHO/trust from the context, never per-event). A binding ("settling") write requires an
  authenticated channel (`prov.auth ∈ {local-user, signed}`); workspace containment is verified against folded
  state. The HTTP ingest gateway (M3) stays DEFERRED (a separate co-versioned package fronting `ingest()`).

### Notes
- **Packaging-only — the frozen event contract is intact and NO wire/read change.** `INGEST_CONTRACT_VERSION`
  stays `1.2.0` and `READ_CONTRACT_VERSION` is unchanged: this release adds a package `exports` subpath
  (`./ingest`), it does not touch the WorkEvent schema, the envelope, the mapper, the authorizer, or any read
  surface. The `.` / `./read` / `./seam` exports are unchanged; `dist` was already in `files`.

## [0.14.1] — `track-operation` skill for CLI write/import routing

### Added
- **`track-operation` skill** (`skills/track-operation/`) — a general agent-facing operating procedure for
  the read-only MCP vs write-capable CLI split. It prevents agents from treating missing MCP write/import
  tools as a blocker, routes BRANCH imports through `track branch import` from the target repo root, and
  documents the `.track/` single-writer constraint. `track install-skills` now deploys it alongside
  `present-decision` and `propose-workpackages` for Claude, Codex, Gemini, and agy.

## [0.14.0] — acceptance-freshness lifecycle: realization anchors + `track consolidate` (multi-worktree/merge)

### Added
- **The fix for the merge treadmill.** Acceptance freshness compares an evidence run's commit to a single
  `baselineCommit` (resolved to the global HEAD), so ANY merge that moves HEAD re-staled EVERY pinned acceptance —
  even items the merge never touched (a "tapis roulant"; surfaced by the sentropic-chat lane, repro item 38c). This
  release adds the anchor + consolidation machinery to heal it WITHOUT weakening gate semantics.
- **`realization.anchored` event + `ItemState.realizedCommit`.** A new append-only kind records the commit an item
  was realized/landed at (last-anchor-wins). Additive optional; priors retained for audit.
- **`track consolidate --items <id,…> --commit <mergeCommit>`** (new `item.consolidate` WorkEvent). At the merge
  hook, for each given item that is `done` AND **accepted-at-its-own-commits** (every criterion has a `pass` run;
  mixed/un-run/waived-only/zero-criteria items are SKIPPED — never re-stamp an unaccepted item), it appends
  `realization.anchored{mergeCommit}` and re-stamps each passing evidence's `acceptance.run` at the merge commit —
  an APPEND-ONLY, attributable producer claim (the merging agent asserts the squash/merge preserves the green tree;
  consistent with track's "records, never verifies"). Item-IDs are caller-authoritative (track has no branch↔item
  link). Atomic batch, `clientToken`-idempotent, workspace-contained, fail-closed on an unknown item.
- **`TrackReader.acceptanceDetail(itemId, baselineCommit)`** — a NEW read DETAIL exposing per-criterion/evidence the
  run-SHA + the item's anchor-SHA + a track-decidable freshness hint `anchor-fresh | needs-ancestry | no-run |
  no-anchor`. The git merge-base/ancestry judgement stays OUTSIDE track (TrackReader holds no git) — the
  branch-lifecycle skill consumes the SHAs. `AcceptanceStatus` is UNCHANGED and stays STRICT; the new detail is
  purely additive, so no pass-only gate (`requireAccepted`, linked-accepted) and no CLI/MCP acceptance enum changes.

### Notes
- **Per-merge, by design.** The heal is per-merge, not permanent: the strict status still compares to the baseline,
  so a later unrelated merge re-stales a consolidated item — the branch-lifecycle SKILL re-runs `consolidate` at each
  merge. This is INTENTIONAL (gates stay strict-`pass`); it must not be "fixed" by reaching back to HEAD-relative
  acceptance (the original bug). Pinned by a 2-merge regression test.
- **Frozen event contract intact** — two additive kinds + one optional field; old logs fold byte-identical
  (`computeHash` of a pre-anchor event unchanged). `INGEST_CONTRACT_VERSION` 1.1.0→1.2.0, `READ_CONTRACT_VERSION`
  1.9.0→1.10.0 (minor). 657 tests.
- **Double-reviewed by the Codex 5.5xhigh + Opus 4.8max PAIR (design + build, converged SHIP).** The pair caught the
  squash/rebase keystone (a naive anchor is defeated by GitHub-default squash) and an over-broad `consolidate` (acted
  on done-but-not-accepted items) — both fixed. Reviews/decisions: `docs/reviews/freshness-design-SYNTHESIS.md`,
  `docs/plan/acceptance-freshness-lifecycle-DESIGN.md`.
- **Follow-on (NOT in this release):** the `branch-lifecycle` skill (ships via `install-skills`) that drives
  `consolidate` at branch-close + does the git ancestry/path judgement.

## [0.13.1] — reconcile seam v0 with `track export-graph` (WP6)

### Notes
- Brings the **`track export-graph`** graph-fragment export (WP6, for graphify ingestion — merged to `main` via
  PR #2) and the **seam v0 freeze** (0.13.0) into one published version. 0.13.0 published the seam-v0 half before
  the graph-export merge had landed; 0.13.1 carries both.
- **`READ_CONTRACT_VERSION` → 1.9.0.** Both features independently bumped the read contract to 1.8.0 (graph-export
  `+graphExport`; seam-v0 `+VerificationRun.artifactLocator`); reconciled to a single 1.9.0 (both additive,
  read-only). `seam-schema.ts` `readContractVersion` follows to 1.9.0. No event-contract change; `INGEST` stays
  1.1.0. 623 tests + the graph-export suite.

## [0.13.0] — harness↔track seam v0 FREEZE (track-side, owner-ratified)

### Added
- **`artifactLocator?` on `scope.verification` (S2).** An optional, OPAQUE producer-owned locator to the canonical
  full `VerificationRun` JSON; `scope.verification.violations[]` is the deterministic `JSON.stringify({severity,code,
  path,message})` display/index projection. track records the locator, never fetches/verifies it. Additive optional
  (model + `WORK_EVENT_SCHEMA` + `assertVerificationRun` drop-when-absent + fold + read projection).
- **Caller-supplied deterministic `evidenceId?` on `acceptance.link` (M2=B).** The harness sets a deterministic
  evidence key so `acceptance.run` resolves single-phase (no two-phase link→read→run); absent ⇒ shipped server-mint
  (back-compat). Guarded **token-aware**: a re-used caller key from a DIFFERENT delivery (or untokened) fails closed
  (`DomainError`), while a legitimate same-`clientToken` concurrent retry is absorbed by the 0.12.0 under-lock
  `(workspace, clientToken)` dedup (the fold carries an in-memory `originClientToken` — derived state, zero hash impact).
- **`@sentropic/track/seam` — the v0 JSON-Schema artifact (`SEAM_V0_SCHEMA`).** A real Draft-2020-12 schema (root
  WorkEvent envelope + `if/then` dispatch on `kind` → per-kind payload `$defs` + the harness-internal per-check
  `VerificationRun`/`VerificationCheck.target` + the FROZEN enums `VerificationCategory(scope|acceptance|security)`,
  `Severity(advisory|blocking)`, `Verdict(clean|violation|conditional)`, `RunResult(pass|fail)`). The harness validates
  its emit against this + both sides contract-snapshot it (BR-H1). A **parity test** pins `SEAM_V0_SCHEMA` against the
  enforced `WORK_EVENT_SCHEMA` (a real wire-drift gate); an `M1` regression fixture pins the harness-owned
  "unique `runId` per emitted verdict" invariant (track keys `verificationRuns` by bare `runId` and does not re-key).

### Notes
- **Frozen event contract intact** — both new fields additive optional / drop-when-absent; old `scope.verification`/
  `acceptance.link` logs fold byte-identical, `computeHash` unchanged (pinned 0.12.0 pre-freeze hash reproduces). No
  kind removed, no required field added, envelope keys unchanged. `INGEST_CONTRACT_VERSION` 1.0.0→1.1.0,
  `READ_CONTRACT_VERSION` 1.7.0→1.8.0 (MINOR). 623 tests.
- **Owner-ratified** (M1 runId invariant, M2=B evidence key, severity-enum freeze, OQ-2/3/6/7 confirms — see
  `docs/plan/harness-seam-v0-FREEZE-DESIGN.md`). **Double-reviewed by the Codex 5.5xhigh + Opus 4.8max PAIR across the
  spec + three build rounds** (each round caught a real defect: a non-validatable schema, then a guard that regressed
  the 0.12.0 idempotency seam — both fixed); convergence recorded in `docs/reviews/seam-v0-build-FINAL.md`.
- The adapter (target-driven routing / fan-out / verdict derivation) is **harness-side** — track ships none; it adds
  only the two additive fields + the published schema. Routing/severity-derivation are frozen cross-contract in the
  snapshot, not on trust.

## [0.12.0] — End-to-end concurrent-retry idempotency (M3 prerequisite)

### Added
- **Under-lock idempotency backstop.** `EventStore.appendCommand` now runs a delivery-token dedup recheck
  *inside* the file lock, atomic with the append — closing the concurrent-retry race the pre-lock `tokenIndex`
  fast-path cannot (two in-flight retries that both saw the token "absent" before either appended). A racing
  retry that defeats the fast-path now dedups to a single append instead of double-writing. The store stays
  generic via an injectable `dedupe(inputs, existing)` hook (default = a `(clientToken, aggregateId)` recheck
  for direct callers); integrity `validate(existing, head)` runs **before** the dedup short-circuit, so a
  duplicate can never return success on a corrupt/tampered/truncated log.
- **Workspace-scoped idempotency at the ingest seam.** Ingest supplies a `(workspace, clientToken)` hook
  (`workspaceDedupe`, resolving each persisted event's workspace via the existing `eventWorkspace` fold). This
  key is **stable across a re-minted aggregateId**, so concurrent `item.create` / `decision.create` /
  `blocker.raise` retries dedup to one event — and **workspace is in the key**, so a token in workspace V can
  never suppress a write in workspace W (the load-bearing namespacing property, now true by construction).
- **Result-id fidelity through the facade.** Every id-returning facade method (`createItem`, `createDecision`,
  `linkEvidence`, `addCriterion`, `openBlocker`, `resolveExternalDependency`) now derives its returned id from
  the **persisted** events (`emit`/`emitBatch` return the `TrackEvent[]` actually written). A deduped concurrent
  retry therefore returns the **original persisted id**, never a freshly-minted, never-persisted one.

### Notes
- **Frozen event contract intact** — no event shape / `contentHash` / `seq` / `prevHash` / `head` change; the
  dedup hook is a pure read; old logs replay byte-identical. The P0 AppendReceipt guard ("never rc=0 without
  persistence") is unchanged. Additive; 583 tests.
- **Double-reviewed by the Codex 5.5xhigh + Opus 4.8max PAIR — converged SHIP after three rounds** (the pair
  diverged twice; the owner-approved "Option B" full seam lifted both BLOCKs). Reviews archived under
  `docs/reviews/M3-prereq-*`; adjudication in `docs/reviews/M3-prereq-SYNTHESIS.md`.
- **Deferred (M3-HTTP gateway, by design):** body-digest "409 on same idempotency-key / different body" conflict
  detection lives at the pre-mint gateway/ingest layer, not the store (a retry legitimately re-mints `id`/`at`,
  so a store-level `contentHash` compare would reject the very race this closes). See `docs/plan/M3-channel-DESIGN.md`.

## [0.11.2] — M5 canevas (track-side): live reads + `item.spec-amend`

### Added
- **Three additive canevas reads (pure, no clock/socket).** `TrackReader.cursor()` → `{head, count}` (log-tail
  hash — the host's liveness primitive) + `changesSince(cursor)`; `TrackReader.canevas(workspace,
  {baselineCommit, decisionId?})` → the materialized report+WP-rollup (+ full dossier when `decisionId` given)
  joined with per-aggregate `prov` lineage (`origin: human|machine` from `prov.proposed`) + open-action
  affordances; `TrackReader.amendmentTrace(aggregateId)` → an ordered prov-tagged human/machine diff
  projection over `spec.amended`/`dossier.revised`/`decision.artifact-added`/`decision.outcome` (zero new event
  data). MCP `track_cursor` / `track_canevas` / `track_amendment_trace` (read-only).
- **`item.spec-amend` WorkEvent → `spec.amended` event** — live spec amendment on the existing item aggregate
  (next seq, no recreate): `{itemId, decisionId?, liveDocRef?, baseHash, patch: JsonPatch, resultHash,
  proposalRef?, summary?}`. Record-only (the JsonPatch is stored verbatim; **no spec field is mutated** — the
  amendment *trace* is the value). Binding-gated, `clientToken`-idempotent, workspace-contained. An AI proposal
  (`prov.proposed:true`, `proposalRef`) and a human acceptance both stay in the trace — **the machine origin is
  never laundered away**. CLI `item spec-amend`.

### Notes
- track's half of M5 (the sentropic canevas host is co-design / D5, not here). Additive: new event kind, old
  logs byte-identical; `READ_CONTRACT_VERSION` 1.6.0 → 1.7.0. 564 tests.

## [0.11.1] — Scope branch: declarative scope state (a) + `track scope validate` (b)

### Added
- **Declarative scope state (a).** `ItemRole` widened to `'workpackage' | 'spec-phase'` (a spec-phase nests
  only under a WP/phase; centralized `assertRoleNesting`); additive `scope?: ScopeDecl {allowed?, forbidden?,
  conditional?}` of **inert path globs** (track stores strings, **never glob-matches**); `scope.declare`
  WorkEvent → `scope.declared` event on the existing item aggregate (binding-gated, role+workspace guard).
  CLI `item new --role spec-phase`, `item scope-declare <id> --allowed/--forbidden/--conditional`. The rollup
  excludes spec-phase from leaf counts (container, like a WP).
- **`track scope validate` (b) — PURE read, advisory, fail-closed.** `TrackReader.scopeValidate` + CLI +
  MCP `track_scope_validate`. Runs `requireFresh` FIRST (stale/altered/not-imported → `StaleSidecarError` ⇒
  `status:'stale'`, **no partial verdict** — reuses the shipped mechanism). Semantic-only: `scope-undeclared`,
  `incoherent` (allowed∩forbidden set overlap, **never glob-matching**), `illegal-nesting`,
  `claim-out-of-phase`, opt-in `delivered-out-of-scope` (OFF). Surfaces the latest ingested VerificationRun
  per WP (read, never recompute). **rc is advisory — never a commit gate**; never ingests/appends.

### Notes
- Completes the track side of the rhanka-ratified scope-ownership (a/b/c shipped: c=0.11.0, a+b here). The
  doc-authority inversion (BRANCH.md → projection) remains a separate gated policy step (cross-repo).
  Additive: `INGEST_CONTRACT_VERSION` unchanged (additive kind), `READ_CONTRACT_VERSION` 1.5.0 → 1.6.0; old
  logs byte-identical. 532 tests.

## [0.11.0] — Shared trunk: VerificationRun ingestion + `status(level)` (harness seam + scope)

### Added
- **VerificationRun ingestion (evidence-only).** `scope.verification` WorkEvent → `scope.verification-recorded`
  event (`Settles:'evidence'` ⇒ signed/local-user channel = the harness/bridge); folds into a
  `verificationRuns` collection and **touches NO realization/bucket logic** — a path verdict can never spawn,
  advance, or complete an item (structural; tested). `violations` recorded verbatim (opaque locators; track
  never re-does glob-matching). `Track.recordVerification`, `TrackReader.verificationRuns()`, MCP
  `track_verification_runs`. Workspace-contained + `clientToken`-idempotent via the existing ingest gates.
- **`status(level)` projection** (`report --level spec|plan|wp|lot|task`, `TrackReader.statusByLevel`, MCP
  `track_status`) — generalizes the WP rollup to named tiers (parity with `computeWpTree` at `wp`/`task`;
  lot/plan/spec = parentId-depth tiers). SUM-not-mean, dropped excluded, `0/0⇒n/a`. Read-only; does NOT promote
  WorkPackage to a first-class aggregate.

### Notes
- The **shared trunk** for the harness→track seam + scope-ownership (specs:
  `docs/plan/harness-seam-and-scope-DESIGN.md`, pair-converged). Additive: a new `'verification'` aggregate +
  `scope.verification-recorded` event are absent on all existing aggregates ⇒ zero hash/seq/bucket change on
  old logs. `READ_CONTRACT_VERSION` 1.4.0 → 1.5.0. 485 tests.

## [0.10.11] — `track workspace-activity` CLI verb (h2a poll surface)

### Added
- **`track workspace-activity --workspace <id> [--baseline-commit <sha>] [--now <iso>] [--idle-ms <ms>]
  [--format json|text]`** — wraps the shipped 0.10.4 `TrackReader.workspaceActivity` as a CLI verb so a peer
  that is itself an MCP server (h2a, stdio — can't be a client of track's MCP) can shell out to poll
  `{pending, stalled[], latestEventAt}`. The library stays clockless; the CLI boundary injects `now`/HEAD
  (same pattern as `report`). Graceful serve-empty (no `.track` → empty + `track init` hint, rc=0); read-only.

### Notes
- Additive; reuses the existing pure 4-rule stalled disjunction; event contract / write path / P0 guard
  untouched. 471 tests.

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
