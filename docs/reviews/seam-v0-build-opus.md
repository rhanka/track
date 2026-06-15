# BUILD REVIEW (Opus 4.8max) — track-side harness↔track seam v0 FREEZE

_Date: 2026-06-15 · Verdict: **SHIP-WITH-CHANGES** (no MUST-FIX; 2 SHOULD-FIX). Suite GREEN (603) masks the gaps._

## Airtight (verified, no finding)
- **Point 1 — FROZEN CONTRACT.** `artifactLocator` + `evidenceId` truly additive: `assertVerificationRun`
  drop-when-absent (`model/verification.ts:96`, gated by non-empty at :85); fold drop-when-absent (`fold.ts:309`);
  `canonical.ts` sorts keys + drops undefined ⇒ pre-freeze payloads serialize byte-identical ⇒ `computeHash`
  unchanged. `evidenceId` on acceptance.link is `str(false)`; absent ⇒ `?? this.newId()` (`track.ts:578`) =
  shipped mint. No kind removed; envelope keys unchanged; MINOR bumps correct (INGEST 1.1.0, READ 1.8.0, SEAM 1.0.0).
- **Point 4 — M1 runId fixture.** `seam-v0.test.ts:185-214` documents the collapse (two same-runId verdicts →
  both persist, `verificationRuns.size===1`, last wins, N-1 lost); pins the harness-owned invariant; track does
  NOT re-key. ✓
- **Point 5 — structural inertness.** Only readers of `state.verificationRuns` are `scope-validate.ts:173`
  (advisory/off-by-default), the read/MCP API, snapshot persistence. `bucketOf`/`statusByLevel`/`acceptanceStatus`
  read it nowhere. A `violation` verdict leaves buckets unchanged (`seam-v0.test.ts:217-234`). ✓
- **Point 3 content — schema faithful TODAY.** `seam-schema.ts` matches the enforced wire field-by-field
  (scope.verification/acceptance.run/acceptance.link required+optional sets ↔ WORK_EVENT_SCHEMA), frozen enums all
  pinned, S1 target shape (`minProperties:1`, `additionalProperties:false`) + S3 correctly modeled.

## SHOULD-FIX 1 — caller-supplied evidenceId collision/clobber (newly-introduced surface)
`linkEvidence` has NO existence/uniqueness guard; the fold does a blind `state.evidence.set(payload.evidenceId,…)`
(`fold.ts:261`), last-writer-wins. Pre-freeze `evidenceId` was always a fresh `newId()` (collision-impossible);
a caller-supplied key opens:
- **Cross-workspace clobber (reachable):** a V-channel re-uses an `evidenceId="X"` already linked by W → the link
  write stays workspace-contained (lands on V's item — no write bypass), but the GLOBAL evidence map entry for X
  is overwritten to point at V's criterion; W's prior link is silently clobbered in the read model, and W's later
  `recordRun("X")` resolves to V → throws `target belongs to workspace "V"` (cross-workspace denial/mis-route).
- **Same-workspace silent re-point (reachable):** re-linking an existing id to a different criterion silently
  re-points it, last-write-wins, no error.
No cross-workspace WRITE bypass / wrong-aggregate write (link is contained, recordRun fails closed) ⇒ SHOULD-FIX
not MUST-FIX, but it is a real newly-introduced containment/correctness regression the freeze's "additive, old
callers unbroken" framing hides. **Fix (fail-closed, track-philosophy-aligned):** in `linkEvidence`, when
`evidenceIdInput !== undefined` and `state.evidence.has(evidenceIdInput)` with a different `criterionId` (or
unconditionally for a caller-supplied id), throw `DomainError('evidence <id> already exists')`. An identical
re-link is absorbed by the clientToken dedup, so the guard does not break legitimate retries. Add a collision test.

## SHOULD-FIX 2 — schema snapshot is a self-pin, not a wire drift-gate
`seam-schema.test.ts` asserts `SEAM_V0_SCHEMA` equals an inline literal — it gates schema-vs-schema edits but NOT
schema-vs-wire divergence (no test imports BOTH `SEAM_V0_SCHEMA` and `WORK_EVENT_SCHEMA`). If `WORK_EVENT_SCHEMA`
later gains/renames a seam-payload field while `seam-schema.ts` is untouched, both suites stay green and the
published contract silently drifts from what track enforces. **Fix:** add a parity test deriving `{required,
optional}` field sets from `WORK_EVENT_SCHEMA['scope.verification'|'acceptance.run'|'acceptance.link']` and
asserting equality with the seam `payloads` — makes it a real drift-gate.

## VERDICT: SHIP-WITH-CHANGES (2 SHOULD-FIX before/with the joint contract-snapshot).
