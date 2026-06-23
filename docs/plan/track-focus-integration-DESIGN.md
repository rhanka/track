# DESIGN — `track focus` CLI integration of `@sentropic/focus@0.3.0`

**Status:** design (Opus 4.8max half delivered + grounded against the real published package; Codex half's
async wrapper glitched — the BUILD is pair-reviewed Codex+Opus, the real gate). Architect-dispatched
2026-06-23 (owner-confirmed: Focus = a TRACK command, the HOME of Focus; `stp focus` becomes a shortcut alias).
v1 = read-only render. L4 (write-path) = a separate co-designed lot.

## Grounding (verified — `npm pack @sentropic/focus@0.3.0`, read every .d.ts)
- Exports: `.` = render-core values `renderTerminal(doc,{width?})→string` / `renderMd(doc,hooks?)→string` /
  `renderHtml(doc,{renderMarkdown,sanitizeHtml})→string` (**hooks REQUIRED**, focus carries no marked/DOMPurify)
  + model types (`DecisionDossierDocument`). `./track` = `readDecisionDossier(eventsPath, {workspace,baselineCommit,decisionId}, readAt)→doc`,
  `toDecisionDossierDocument(view, amendmentTrace, meta)`, errors `DecisionNotFoundError`/`TrackContractMismatchError`,
  `EXPECTED_TRACK_READ_MAJOR=1`. `./cli` = `run(argv, deps?)→Promise<number>` (the `stp focus` driver).
- `./track`'s `readDecisionDossier` **re-opens the log itself** (takes an `eventsPath` STRING, builds its own
  `TrackReader`, gates `majorOf(contractVersion)!==1`, calls `canevas(ws,{baselineCommit,decisionId}).dossier`
  + `amendmentTrace` + `cursor`). No reader/dossier injection seam at the published surface.
- `@sentropic/focus` deps `@sentropic/track:^0.17.0`; track is 0.18.0 (major 1) → npm DEDUPES to one track
  instance; focus's `EXPECTED_TRACK_READ_MAJOR=1` satisfied by READ 1.12.0. The `DecisionDossierView`/
  ComprehensionEvidence shapes + `/read` self-contained barrel are confirmed sufficient for focus's type imports.

## 1. Consumption — `./track` + `.` (NOT `./cli`)
`track focus` resolves the store + flags THE TRACK WAY, then calls focus's `readDecisionDossier` + dispatches the
render-core. Do NOT wrap `./cli` (its `stp`-shaped usage text / exit map / argv parser / `--events-path` don't fit
track's resolver + conventions — that's mis-reuse, not reuse).

```
track focus <decision-id> --workspace <w> [--format terminal|md|html] [--baseline-commit <sha>]
  → resolveTrackDirOrNull(...) → eventsPath = <trackDir>/events.jsonl   (track owns store resolution)
  → baselineCommit = resolveCommit(cwd, --baseline-commit)              (HEAD/refs/short-SHA → 40-char)
  → doc = focusTrack.readDecisionDossier(eventsPath, {workspace, baselineCommit, decisionId:id}, new Date().toISOString())
  → terminal → core.renderTerminal(doc) | md → core.renderMd(doc) | html → core.renderHtml(doc, HTML_HOOKS)
```

## 2. Dependency cycle — `optionalDependencies` + dynamic `import()` (RATIFIED reco)
`@sentropic/focus` deps `@sentropic/track`; a normal `track→focus` dep would be a hard cycle that inverts the
layering (track = substrate, focus = consumer). Resolution:
- `package.json`: `"optionalDependencies": { "@sentropic/focus": "^0.3.0" }` (NOT `dependencies`/`peerDependencies`)
  + `"devDependencies": { "@sentropic/focus": "^0.3.0" }` (types + CI integration test).
- The `focus` handler does `await import('@sentropic/focus/track')` + `await import('@sentropic/focus')`, wrapping a
  `MODULE_NOT_FOUND` into a helpful "rendering requires @sentropic/focus — run `npm i @sentropic/focus`" (rc=1).
- Keeps track's CORE publishable + usable with ZERO knowledge of focus; `track focus` is an additive, opt-in
  capability (matches track's posture: MCP read-only, writes CLI, capabilities additive). npm dedupes the back-edge
  to the already-present track 0.18.0 (no second instance, no loop).

## 3. CLI wiring (`src/cli/index.ts`)
- The focus case is **async** (dynamic import) → make `runCli` return `number | Promise<number>`; `bin.ts` →
  `Promise.resolve(runCli(...)).then(rc => process.exit(rc))`. Every other command stays sync.
- Place `focus` in the **serve-empty read group** (with report/query/validate/scope/workspace-activity), using
  `resolveTrackDirOrNull`; a focus over an unadopted repo serves not-found (rc=3), not a crash.
- Handler mirrors `cmdWorkspaceActivity`. Flags: `--workspace` (REQUIRED), `--format terminal|md|html` (default
  terminal, validated via `oneOf`), `--baseline-commit` (via `resolveCommit`). Do NOT expose `--events-path`
  (track owns store resolution via `--track-dir`/`TRACK_DIR`/ancestor-walk; `ctx.eventsPath` is the single source).
- `HTML_HOOKS`: a ~6-line `{ renderMarkdown: escape-into-<pre>, sanitizeHtml: identity }` (focus's
  `defaultHtmlHooks` is NOT exported, so track defines its own). No markdown/sanitizer lib in core.
- Error map (preserve focus's scriptable exit codes): missing args → 2 + usage; `DecisionNotFoundError` → 3;
  `TrackContractMismatchError` → 4; focus-not-installed → 1 + install hint; other → 1. Add one `USAGE` line.

## 4. One source of truth (self-consumption note)
npm dedupes to a single `@sentropic/track@0.18.0` → no two `TrackReader` classes, no type duplication; the boundary
is **primitives-in (eventsPath, {workspace,baselineCommit,decisionId}, readAt), focus-type-out (doc)**. Clean.
KNOWN seam (accept for v1): focus's `./track` only takes an `eventsPath` string → for one command there are TWO log
reads + TWO contract gates (track's implicit + focus's explicit). **v1.1 escape hatch (deferred):** track builds
its own `TrackReader`, calls `canevas`/`amendmentTrace`/`cursor` (reads it already owns), then focus's exported
`toDecisionDossierDocument(view, amendmentTrace, meta)` → one reader, one gate, focus reduced to pure render. Defer
(it duplicates focus's orchestration conventions into track); use only if the double-read/gate ever bites.

## 5. v1 scope + the L4 write seam (NOT here)
v1 = read-only render (focus@0.3.0 is itself read-only: no auth, no identity, no clock, no write). `track focus`
reads `events.jsonl` + renders; writes nothing, creates no `.track`. **L4 (separate lot, co-designed with the
architect):** the write-path `ratifyOutcome`→`decision.outcome` / `amendSpec`→`spec.amended` via
`@sentropic/track/ingest` (auth-by-context, CLI = `local-user`). The seam is precisely focus's `Affordance.enabled:
false` placeholders + track's `decisionAffordances` — L4 flips disabled→live + routes to a track ingest WorkEvent.
Crosses the read/write boundary + introduces identity → its own pair-designed lot. Do NOT touch in v1.

## Version
package `0.18.0 → 0.19.0` (minor: new CLI command + optionalDep). No event/read contract change (read-only,
consumes existing READ 1.12.0). INGEST/READ versions unchanged.
