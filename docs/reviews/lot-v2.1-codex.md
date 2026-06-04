# Lot v2.1 — Codex (gpt-5.5 xhigh) review

Adversarial review of CI→acceptance ingest idempotency (`src/track.ts` `ingestRuns`). Paired with `docs/reviews/lot-v2.1-opus.md` (Opus 4.8) — both converged.

## Round 1 — verdict: ship-with-changes (converged with Opus)
- **MAJOR (flap)** the first attempt deduped on the 5-tuple `(evidenceId, commit, env, runner, result)` against the WHOLE history → a flaky recovery whose result recurred earlier was dropped: `pass→fail→pass` left `latestRun=fail` (false negative); `fail→pass→fail` left `latestRun=pass` (**false green** — dangerous for a gate). PLAN's bare 4-tuple is also wrong (drops the first change). **Fix:** dedup against the LATEST result per `(evidenceId, commit, env, runner)`, append when the candidate differs. + `pass→fail→pass` and `fail→pass→fail` regression tests.
- **MAJOR (test gap)** no flap regression test — the suite certified green the exact broken behavior. **Fixed.**
- **minor** existing-log keys built from `unknown` payload joins vs typed candidate keys → type-guard all fields + share one key builder. **Fixed** (`JSON.stringify` key, typeof guards).
- **minor** NUL separator not enforced. **Fixed** (`JSON.stringify`, collision-proof).
- **minor** workflow silent-green on missing `.track`/locator drift; no persist step. **Documented** in the workflow header.
- **Correct as-is:** per-evidence keying preserves multi-evidence fan-out; append-only untouched; `parts.length===0 ⇒ no-op`.

## Round 2 — verdict: rework
- **MAJOR (intra-report idempotency)** remembering only the latest result still let a same-tuple intra-report flip `[pass, fail]` re-ingest non-idempotently (`pass,fail,pass,fail…`). **Fix:** a report asserts one result per test → collapse intra-report duplicates to the LAST result per tuple, THEN dedup vs the log. + test "collapses an intra-report flip [pass,fail] to one run and re-ingests as a no-op".

## Round 3 — verdict: **ship**
- True re-ingest is a no-op for same report/commit/env/runner; dups/flips collapse last-wins per evidence tuple; shared locator stays N on first ingest, 0 on repeat.
- Cross-report flaps still append each transition; `latestRun` follows stream order, no false-green.
- No remaining ingest hole; append-only untouched; `parts.length===0` returns before append. Verified 176/176 + typecheck.

## Outcome
Idempotency by construction: (a) latest-per-tuple from the log, (b) collapse the report to last-per-tuple, (c) emit only on change. Re-ingesting any report is a no-op; genuine cross-report transitions (incl. flaky recoveries) are recorded; no false-green. 176 tests green, tsc clean. Reusable workflow at `.github/workflows/track-acceptance.yml`.
