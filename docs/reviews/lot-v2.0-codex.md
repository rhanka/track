# Lot v2.0 — Codex (gpt-5.5 xhigh) review

Multi-round adversarial review of the curated read contract (`src/read/contract.ts`, `src/branch/signature.ts`). The `-o` capture failed on round 1; rounds 2–5 were run on the revised code. Each round is consolidated below with the fix applied.

## Round 2 — verdict: rework
- **BLOCKER** `provenanceFrom` skipped a malformed *latest* `branch.imported` and fell back to an older valid stamp → with a re-chained malformed latest, `validate` passes and `requireFresh` could pass against old content. **Fix:** select the latest matching-locator stamp; if its shape is invalid → `undefined` (absent), never fall back. + test.
- **MAJOR** `branchSlug` excluded from the signature → same locator re-pointed to a different BR id with identical lots reads false-FRESH. **Fix:** include `branchSlug` in `branchSignature`. + test.
- **MINOR** test gaps (UAT `passed`, new lot, branchSlug drift, latest-malformed-no-fallback); PLAN-v2 text still said `sourceHash`. **Fixed.**
- **Confirmed:** F3 subpath present; F4 single read; A1 cadence preserved (no extra events on reorder); removals are fail-closed-stale.

## Round 3 — verdict: rework
- **MAJOR (false-FRESH)** `importBranch` resolves `branchSlug` via `fileSlug`, but stamped `structureHash` via `branchSignature(content)` *without* it → two headingless contents with different fileSlugs but same lots collide. **Fix:** `branchSignature(content, branchSlug?)`; importBranch stamps the resolved `parsed.branchSlug`; reader derives without fileSlug → headingless+fileSlug reads conservatively STALE (fail-closed). + tests.

## Round 4 — verdict: rework
- **Residual false-FRESH** reader-side `parseBranch(content)` falls back to `slugify(title)` when no BR id → a no-BR + fileSlug import can read fresh if the title slug equals the fileSlug.
- **Stale dist/** exported artifact still had the old contract.
- **Fix:** freshness is authoritative ONLY when the content carries a `BR-NN` id (`branchId()`, sharing `BR_ID` with `deriveBranchSlug`); otherwise **fail closed (stale)**. + "no loophole" test. `npm run build` rebuilt dist.

## Round 5 — verdict: **ship**
- No residual unsafe `requireFresh` pass: no `BR_ID` ⇒ stale before hash equality can matter.
- BR-id path still works: current hashes match; structural drift diverges.
- `branchId` shares `BR_ID` with `deriveBranchSlug`; dist carries the gate.

## Outcome
167 tests green, `tsc --noEmit` clean, dist rebuilt. Guard is fail-closed by construction: latest-stamp authoritative + payload-shape-validated, structural signature over the reconciled projection (`branchSlug`, lot `done`, UAT `passed`), BR-id authority gate, and integrity check — all four must hold for `requireFresh` to pass. Paired with `docs/reviews/lot-v2.0-opus.md` (Opus 4.8, ship-with-changes, applied).
