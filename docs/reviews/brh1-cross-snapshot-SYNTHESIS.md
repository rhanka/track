# BR-H1 cross-contract snapshot — pair synthesis (Codex 5.5xhigh + Opus 4.8max)

**Inputs.** Harness PR #343 `feat/harness-verification-run-v0-targets` (harness 0.3.0) →
`packages/harness/schema/verification-run.schema.json` (draft-07), fetched read-only to
`/tmp/brh1/`. Track half = `SEAM_V0_SCHEMA` (`src/ingest/seam-schema.ts`, Draft 2020-12),
shipped `@sentropic/track@0.13.1`.

**Verdict (both halves converged).** NO wire-breaking incompatibility. BR-H1 #343 is
mergeable; the convergence is **100% track-side** (track's half of the atomic pair). Zero
harness change forced — only 3 direction ratifications + track-side fixes.

## Pin-correction (load-bearing — both agents)

The two schemas are at **different layers**, not the same artifact at two dialects:
- **harness root** = the producer-internal `VerificationRun` (PRE-projection: run + checks + targets).
- **track `SEAM_V0_SCHEMA`** = the `WorkEvent` wire envelope (POST-projection: `scope.verification`
  / `acceptance.run` / `acceptance.link`), PLUS an embedded **agreement-mirror**
  `$defs.{VerificationRun, VerificationCheck, VerificationTarget, Violation}` (seam-schema.ts:107-175).

→ The drift-gate pins **harness root ↔ track's agreement-mirror `$defs` + shared enum `$defs`** —
NEVER a whole-root `toEqual` (different layers + `definitions`/`$defs` + `minLength`). Compare
**normalized projections** (enum arrays, required arrays, property-name sets). Dialect
(draft-07 vs 2020-12) is metadata-only; the validator is dialect-agnostic (architect pre-aligned).
Pinning the projection payloads against harness = the #1 way to ship a broken gate.

## Parity table (reconciled)

| Inv | Verdict | Note |
|---|---|---|
| S1 per-check target | **DIVERGE → D1** | harness `target` OPTIONAL on check (fail-closed adapter-side, per OQ-2); track mirror REQUIRES it. |
| S2 artifactLocator | MATCH (mirror) / **wire looser** | mirror requires it; track wire `ScopeVerificationPayload.artifactLocator` is additive-OPTIONAL. → wire-hardening call. |
| S2 violations projection | by-design | harness Violation = object; track projects to `string[]` via deterministic `JSON.stringify` (S2). Sub-point: `Violation.path` required-ness diverges → **D2**. |
| S3 verdict + result | MATCH | tri-state derived (descriptive, both); `result` binary `pass\|fail` both. |
| S4 routing | MATCH | target-driven; runtime honors (ingest.ts:259-284). |
| M1 runId | **DIVERGE (semantic)** | harness `runId` = physical-per-invocation; track mirror description mislabels it as the per-verdict projection id. → track mirror doc-fix. |
| M2=B evidenceId | MATCH (mirror) / **wire looser** | `AcceptanceLinkPayload.evidenceId` OPTIONAL on track wire (legacy server-mint back-compat); harness seam always supplies the deterministic key. → wire-hardening call. |
| severity enum | MATCH | `[advisory, blocking]` both. |
| VerificationCategory | **DIVERGE → D3** | harness 8-value verify-taxonomy (incl. `security`) vs track 3-value `[scope,acceptance,security]` routing enum. Share only `security`. Naming collision — DO NOT equate. |
| clientToken | MATCH | correctly track-only (absent from the neutral artifact). |

## Divergences → action

- **D1 (ratify):** relax track mirror `$defs.VerificationCheck.required` to drop `target`
  (target optional in schema, fail-closed stays adapter behavior) — matches harness + OQ-2. *[pair reco: relax track]*
- **D2 (ratify):** path-less violation canonicalization for the deterministic stringify —
  align track mirror to `path` OPTIONAL + **omit** (no empty-string fill). *[pair reco]*
- **D3 (no change):** gate asserts only `security`-reserved-on-both (membership), never enum-equality.
  Optional: rename track's 3-value enum to kill the collision (track-internal cleanup, not a blocker).
- **M1 (track fix):** correct track mirror `$defs.VerificationRun.runId` description → physical-per-invocation
  (matches harness); projection-id semantics stay on the emitted `ScopeVerificationPayload.runId`; adapter mints per M1.
- **Wire-hardening (track, FYI non-blocking):** require `artifactLocator` + `evidenceId` on the
  **seam-sourced** wire path (harness always supplies both); legacy non-seam path stays loose.

## Drift-gate design (both agree)

- Vendor a fixture copy `src/ingest/__fixtures__/harness-verification-run.schema.json` + record its
  **SHA-256** → any intentional harness update is a reviewable fixture diff. NOT a devDep on
  `@sentropic/harness` (deterministic, no network, no install-graph coupling, #343 may be unpublished at gate time).
- New test `src/ingest/seam-harness-parity.test.ts` (beside `seam-schema.test.ts`, no config change).
- Assert **normalized projections** reading live `SEAM_V0_SCHEMA` + the vendored harness fixture:
  enum equality (severity, result, evidence-kind, verdict, schemaVersion/v const); target shape
  (`scope.required`, `acceptance.required`/props, `minProperties`); `artifactLocator` required both;
  `security` **membership** (not enum-equality); D1/D2 `required` pinned once ratified.
- No network, no harness checkout, no auto-updating snapshots.

## Build plan (track's half of the atomic pair)

Pending architect nod on D1/D2 + the 2 wire-hardening calls → delegate TDD + pair-review:
(a) mirror fixes (D1 target-opt, D2 path-opt, M1 runId desc) + seam-wire hardening;
(b) the drift-gate test. Track PR merges ATOMIC with harness #343.
