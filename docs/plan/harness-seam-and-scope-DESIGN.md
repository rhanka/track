# harness→track SEAM + WorkEvent v0 + scope-ownership — design

**Date:** 2026-06-10 · **Status:** owner-approved (Q1+Q3 ok), build-ready · **Double-reviewed by the Codex
5.5xhigh + Opus 4.8max PAIR (converged).** Owner = rhanka (= the project owner; the peer agents' "rhanka-
ratified" = the owner ratified it in a sentropic session — re-confirmed here). Reply sent to claude:sentropic.

## A. Seam + WorkEvent v0 (sentropic non-engaging ask)
- **ONE contract.** track's shipped ingest `WorkEvent {v,kind,payload}` (`INGEST_CONTRACT_VERSION 1.x`) IS the
  v0 wire format. "Freeze v0 WITH track" = publish track's frozen envelope as a consumable JSON-Schema/`.d.ts`;
  **@sentropic/harness emits it directly** (validates against the schema artifact, never imports track
  runtime). No upstream schema, no WorkEvent mapping adapter. Compat rule already in code: unknown major ⇒
  fail-closed reject; unknown minor ⇒ "unknown kind".
- **`VerificationRun` = the ONLY true adapter.** It is a batch artifact (N violations over a tree), not a
  WorkEvent → a track-side pure transcoder fans it into existing `acceptance.*` (criterion/link/run) as
  **EVIDENCE**. A path verdict **NEVER** becomes a DONE/TO-DO item (structural: `bucketOf` never buckets by
  acceptance result; it only flips an already-`done` item under `requireAccepted`). The C2 code + path stay in
  the artifact / a locator — **opaque to track; track never re-does glob-matching.** Severity→pass/fail is an
  adapter policy, not the contract. Evidence target must be explicit/resolvable (evidenceId / stable key /
  exact locator) — no glob ownership in track; unmapped ⇒ fail-closed/reported, never auto-itemized.
- **`status(level)` (spec|plan|wp|lot|task) = a read projection**, generalizing `computeWpTree`+`bucketOf`:
  `task`=leaf bucket, `wp`=existing `role:'workpackage'`+`parentId` rollup, `lot|plan|spec`=same rollup over
  configured tiers (parentId containment / links). Group rollup: AWAITED if any active descendant awaited; DONE
  if all done; counts `done/active/dropped/pct`, dropped excluded, `0/0⇒n/a`. **Additive read-only; does NOT
  promote WorkPackage to a first-class aggregate** (the marker + rollup is "WP out of core"-compatible).
- **Direction (record-only, confirmed):** harness EMITS → track INGESTS; neither imports the other; the
  adapter is 100% track-side; actor/workspace/auth/proposed come from the ingest channel, never per event.
  Engine track-OPTIONAL; sentropic profile track-required by **policy**, not dependency.

## B. Scope-ownership (rhanka-ratified frame — CONFIRMED by the pair)
Authority by layer: **track = MASTER of the semantic scope DECLARATION** (WP→spec-phase) + realization status;
**harness = path verdict + the SOLE synchronous commit gate** (track read-only cannot block — structurally
true). track declares + records, never blocks. **One divergence adopted:** keep `track scope validate` (read,
pure) SEPARATE from VerificationRun ingestion (write) — folding them re-introduces a coupled/blocking path.

### (a) Declarative scope state — additive refinement of `role`+`parentId`
- widen `ItemRole = 'workpackage' | 'spec-phase'` (a phase nests under a WP/phase; labels derive from tree
  position; rollup unchanged — phases are container nodes).
- `scope?: ScopeDecl {allowed?, forbidden?, conditional?: string[]}` — **inert path globs** on a WP/phase
  (track stores strings, NEVER matches them — the harness reads them to compute the path verdict).
- `scope.declare` WorkEvent → `scope.declared` event on the existing item aggregate (next seq, binding-gated,
  role+workspace guard). Zero hash change on old events. **Est. ~1–1.5 d.**

### (c) VerificationRun ingestion — `acceptance.run`-shaped, signed channel
- `scope.verification` WorkEvent → `scope.verification-recorded` (Settles:'evidence' ⇒ binding/signed = the
  harness/bridge), folds into an evidence collection, **touches no realization/bucket logic**. Reuses ingest's
  containment + binding-auth + clientToken verbatim — zero new authorization code. **Shared with seam §A.**
  **Est. ~0.75–2 d.**

### (b) `track scope validate` — PURE read
- `TrackReader.scopeValidate` + CLI `track scope validate` + read MCP tool. Runs `requireFresh` FIRST
  (**fail-closed reuse**: stale/altered/not-imported → `StaleSidecarError`, no silent fallback). Validates
  declaration coherence (allowed∩forbidden overlap, legal phase nesting, claimed items are phase descendants),
  surfaces the latest ingested VerificationRun verdict (read, never recompute), optional opt-in
  "delivered-out-of-scope" inference (a read view, never a write). Output `{pass|fail|stale|missing, findings,
  bucket summary, scopeRevisionHash}`; **rc is advisory, never a commit gate.** **Est. ~1–2 d.**

### Anti-false-master sequence (gated)
1. ship (a) — track can HOLD the declaration (docs unchanged, BRANCH.md still master).
2. ship (c) — track can RECEIVE harness path evidence.
3. ship (b) semantic-only — track can RENDER a verdict, fail-closed.
4. wire `track scope validate --verification-run` + `stp scope check` (single routed surface: track=semantic,
   harness=path).
5. dogfood dual mode.
6. **ONLY THEN** invert docs (MASTER.md/BRANCH.md → projection/fallback) — a policy edit, **zero code**, gated
   on (a)(b)(c) green. **FAIL-CLOSED** whenever `.track` is present but declaration absent/stale/altered/
   not-imported/ruleset-hash-mismatch/wrong-commit. track absent = the only case harness owns scope locally.

**Total ~3–5 d**, fully additive, hash-identical old logs, every gate reusing shipped `ingest`/`requireFresh`.

## C. Build order (owner-approved Q3)
**Shared trunk first** (serves both A and B): VerificationRun ingestion (c) + `status(level)`. Then (a)
`scope.declare`, then (b) `scope validate`. M5 (separate doc) in parallel.
