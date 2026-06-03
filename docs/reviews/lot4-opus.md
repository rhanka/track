# Lot 4a + 4b Review — `@sentropic/track` (Opus 4.8)

**Gate:** typecheck clean · `npm test` 108/108 green · `src/events/*` unchanged.

## Acceptance cascade — TOTAL & faithful to §2.4 (verified, 13/13 edge probes)

`accept/status.ts`. Every ordering edge verified: fail+waiver (A6)→fail; fail+stale→fail; waiver over stale/no-run/zero-evidence→waived; mixed pass+stale→stale; mixed pass+no-run→unknown; item unknown+waived→unknown; stale+waived→stale; waived+pass→waived; revocable both ways; zero criteria→unknown. **Total** (closed lattice, unconditional `pass` fallback; no undefined/throw). The zero-evidence-no-waiver⇒unknown rule (`status.ts:23`) is the CORRECT reading of §2.4 (literal step-5 "all pass" on zero evidence would wrongly yield pass). No bug.

`latestRun` = last in stream order (not `at`) — correct per §3. `baselineCommit` query-time param — correct.

## fold refactor → State accumulator — NO regression

Line-by-line diff: Lot 1-3 cases are a mechanical 3-maps→1-state rewrite, identical logic; only acceptance.* + priority.assessed are new. Determinism intact; 108 prior tests green.

## A3, WSJF — correct

addCriterion rejects a decision id (decisions/items disjoint). WSJF score + jobSize>0 guard (rejects NaN/neg); latest=live; frozen dossier snapshot independent; inputs cloned — no aliasing.

## Findings

| # | Sev | Location | Issue |
|---|-----|----------|-------|
| A | minor | `accept/ingest.ts` parseJson | JSON unknown/skipped/errored status → false `pass` run (JUnit handles skipped; JSON doesn't). Fix: skip non pass/fail statuses. |
| B | minor | `model/acceptance.ts` AcceptanceStatus | No `'n/a'` member; a decision returns `unknown` — Lot 5 misbucket risk. Fix: add `'n/a'` + early-return for decision ids. |
| C | nit | `track.ts` ingestRuns | Duplicate locators: only first evidence gets the run (`find`). |
| D | nit | `ingest.ts` | Empty-locator entries emitted. Omit them. |
| E | nit | `accept/status.ts` | `commit` compared raw `!==` (no short/full SHA normalization). |

No blockers, no majors. The acceptance TOTAL cascade is total and faithful; fold refactor preserves Lot 1-3; WSJF correct. Address A and B in/before Lot 5.

**VERDICT: SHIP**
