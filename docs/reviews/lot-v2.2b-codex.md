# Lot v2.2b — Codex (gpt-5.5 xhigh) review

Review of the `linked-accepted` hybrid-A implementation (commit-relative blocker openness). Paired with `docs/reviews/lot-v2.2b-opus.md` (Opus 4.8, verdict **ship**). Both confirmed the core; Codex caught one CLI gap Opus missed.

## Verdict: ship-with-changes (CLI in scope) → all changes applied

### major — CLI did not ship the feature end-to-end (FIXED)
`src/cli/index.ts` still rejected `--rule linked-accepted` (`RESOLUTION_RULES = ['linked-done','manual']`) and `cli.test.ts` asserted the rejection — so the `track` bin (a published surface) could not create a `linked-accepted` blocker. **Fix applied:** added `linked-accepted` to the CLI enum + usage; replaced the rejection test with an end-to-end CLI test that raises the blocker and asserts AWAITED → TO-DO → AWAITED across `accept run --commit` (pass → fail), proving revocation through the real CLI.

### minor — commit-blind barrel helpers (FIXED)
`state/index.ts` re-exports `openBlockers`/`openBlockersForItem`, which return the conservative fold scalar; an external await-path caller would get over-open answers for accepted `linked-accepted` blockers. **Fix applied:** hard ⚠️ COMMIT-BLIND JSDoc on both, pointing to `effectiveOpenBlockersForItem`.

### nit — revocation only pinned through `bucketOf` (FIXED)
Added end-to-end revocation tests through both `Track.report` (AWAITED bucket) and the CLI `query --bucket AWAITED --commit`.

## Confirmed sound
Projection semantics correct: strict pass-only, `resolvedByEvent` first, `linked-accepted` derived from `acceptanceStatus(ref, baselineCommit) !== 'pass'`, settle-once rules on the fold scalar. **`fold` stays baseline-free; no `report ↔ state ↔ accept` import cycle. All production AWAITED paths go through `bucketOf → effectiveOpenBlockersForItem`. Snapshot serialization of `blocker.open` does not interfere.** Deferring `decision-settled` (covered by `kind:"decision"`), per-workspace `requireAccepted`, the validate hint, and BRANCH sub-checkbox is sound. Verified `typecheck` + 17 files / 187 tests green.
