# Adversarial review — @sentropic/track Lot v2.2b (linked-accepted, hybrid-A)

Reviewer: Opus 4.8. Scope: implementation of `docs/plan/v2.2a-linked-accepted-DESIGN.md` (hybrid-A — `linked-accepted` openness derived at projection time vs `baselineCommit`, revocable; strict pass-only owner policy: `waived`/`stale`/`unknown`/`fail` all HOLD the gate). Working dir read-only; no source modified.

Evidence: `npx tsc --noEmit` clean (no cycle, strict). `npx vitest run` = 17 files / 183 tests pass; the four most-relevant files (`blocker-status`, `track`, `fold`, `decision`) = 40/40.

## VERDICT: ship

The projection is correct and fail-safe; every AWAITED/await path is commit-relative; `fold` stays baseline-free; no import cycle; revocation works with zero new events; scoping deferrals break no invariant. Findings below are all minor/nit — none gate the ship.

---

## 1. Correctness of the projection — strict pass-only

Correct. `effectiveBlockerOpen` (`src/report/blocker-status.ts:28`) dispatch order is sound for every (kind, rule):

| kind | rule | resolvedByEvent | path | result |
|---|---|---|---|---|
| dependency | linked-accepted | false | acceptance branch | `acceptanceStatus(ref) !== 'pass'` ✓ revocable |
| dependency | linked-accepted | true | line 33 `return false` | hard-closed (manual resolve is rejected for this rule, so only reachable in principle) |
| dependency | linked-done | any | fold scalar | `isOpen` ref-realization ✓ |
| dependency | manual | any | fold scalar / resolvedByEvent | ✓ |
| decision | (n/a) | false | fold scalar `open=true` | AWAITED until outcome ✓ |
| decision | (n/a) | true | line 33 | resolved on go/no-go ✓ |

- `resolvedByEvent`-first is right: it dominates every rule (matches `isOpen` at `fold.ts:262`).
- `ACCEPTED_CLOSES = {'pass'}` (`blocker-status.ts:21`) is consistent with `requireAccepted`'s `=== 'pass'` (`buckets.ts:30`) and design P3/P4. `waived`/`stale`/`unknown`/`fail` ∉ set ⇒ all HOLD. Strict pass-only confirmed.
- No rule/kind now resolves wrongly. A `linked-accepted` ref is structurally constrained to a non-decision item (`openBlocker` throws on a decision ref unless `kind==='decision'`, `track.ts:268-274`), so `acceptanceStatus` never returns the `'n/a'` decision sentinel on this path — it returns `unknown` for a criteria-less ref (stays open, fail-safe).

## 2. Fold conservative-open soundness

Sound and fail-safe.
- `isOpen` (`fold.ts:261-275`) folds `linked-accepted` to the catch-all `return true` (conservative OPEN). It can never be false-CLOSED for an accepted ref, because the fold scalar is *never authoritative* on an await path — it is overridden by the projection.
- **Every AWAITED path goes through the projection.** `bucketOf` (`buckets.ts:25`) is the only producer of the AWAITED bucket, and it calls `effectiveOpenBlockersForItem(state, id, config.baselineCommit)`. All consumers reach AWAITED only via `buildReport`→`bucketOf`: `Track.report`/`Track.query` (`track.ts:433,438`), `TrackReader.report`/`query` (`read/contract.ts:83,88`), and the CLI `report`/`query`/`item ls` (`cli/index.ts:209,354,366`). None bucket off the fold scalar.
- **The two production reads of `blocker.open` are both non-await, settle-once contexts**, so the conservative value is correct there:
  - `track.ts:206` — `setOutcome` filters `b.kind === 'decision' && ... && b.open` to find the decision blocker to resolve. Decision blockers fold authoritatively (`open=true` until resolved); never `linked-accepted`. Correct.
  - `track.ts:296` — `resolveBlocker` guard, gated by `assertManualResolve` to `rule==='manual'` only. A `linked-accepted` blocker throws before this read. Correct.
- **OLD `openBlockers`/`openBlockersForItem` (`fold.ts:65,70`, re-exported `state/index.ts:2`) are dead on every production await path** — grep shows callers only in `state/fold.test.ts` and `decision.test.ts`. Both still bucket correctly *there* because those tests use only `decision`/`linked-done` blockers (whose fold scalar is authoritative). See finding M1 for the latent trap.
- Snapshot round-trip: `serializeState`/`deserializeState` carry `blocker.open` (`snapshot.ts:34,47`), but every read path re-derives via the projection, so the cached conservative `true` is never consulted for `linked-accepted` bucketing. No interference.

## 3. Determinism / no cycle

Confirmed. `fold.ts` imports only `events/types` and `model/*` (`isSettled`) — never `accept/status` or `report/blocker-status` (grep + tsc clean). `blocker-status.ts` is imported only by `report/buckets.ts` and the `report/index.ts` barrel — i.e. reached only at projection time. Dependency direction is strictly `report → {state, accept}`; `state` and `accept` do not import `report`. No `report ↔ state ↔ accept` cycle. `fold` output is a pure function of the event stream, independent of acceptance/commit.

## 4. Commit-relative AWAITED coherence

Coherent. The same item can be AWAITED at baseline `c2` (ref `stale`/`unknown` there) and TO-DO at `c1` (ref `pass`) — proven by `blocker-status.test.ts:74-86`. `baselineCommit` is *required* (non-optional) on `ReportOptions` (`build.ts:34`) and `ReportConfig` (`buckets.ts:11`), and is supplied on every read path: CLI defaults to `gitHead(io.cwd)` (`cli/index.ts:214,355,378`), `TrackReader` requires the caller to pass it (`contract.ts:83,88` — the adapter owns git, by design). No await path reaches `bucketOf` without a baseline. The v2.0 read contract surfaces the commit-relative answer uniformly because it shares the same `buildReport`/`bucketOf`.

## 5. Revocation correctness

Correct — pure projection, zero events. `blocker-status.test.ts:65-72` proves a `pass→fail` at the same commit re-opens AWAITED with `blockers.size` unchanged (no new event). A `done` ref that regresses re-AWAITs dependents because re-fold is unnecessary — the same folded state yields a different bucket at the same baseline once the new `acceptance.run` event lands. The snapshot cache does not interfere (§2): the serialized `blocker.open` is conservative `true` and is bypassed by the projection on every read. Re-fetching the blocker from current state (as the tests do) is the correct usage; nothing latches.

## 6. Scoping

Sound. Shipping ONLY `linked-accepted` is internally consistent:
- `ResolutionRule = 'linked-done' | 'linked-accepted' | 'manual'` (`model/blocker.ts:5`) — `decision-settled` is genuinely absent (grep: only a comment). Deferring it is safe because the `kind:"decision"` blocker + go/no-go batch (`track.ts:203-233`) already implements the same "open until the decision settles" semantic via `resolvedByEvent`; a `deferred` outcome emits no resolve so the target stays AWAITED on the fold scalar. No promised invariant is broken.
- `requireAccepted` is per-report-option / per-CLI-invocation, not yet per-workspace config (`build.ts:35`, `cli/index.ts:356`). The design (§6) lists "per-workspace" as a v2.2b deliverable; the shipped form is per-invocation `--require-accepted`. See finding m2 — a scope-vs-design gap, not a correctness bug.
- `validate` desync hint and BRANCH-import gate sub-checkbox are explicitly deferred; `desync.ts` remains detect-only as designed. No invariant depends on them.

## 7. Test adequacy

Strong. Covered: revocation re-opens (`blocker-status.test.ts:65`), strict pass-only incl. `waived`/`stale`/`unknown`/`fail` HOLD (`:74`, `:88`), fold-stays-baseline-free / projection authoritative (`:95`), settle-once `linked-done` unaffected (`:103`), `openBlocker` no longer throws (`:39`, `track.test.ts:146`). Gaps in finding list (n1–n3) are minor.

---

## Findings

### M1 (minor) — `state/index.ts:2` re-exports the commit-blind `openBlockers`/`openBlockersForItem`
These are a latent foot-gun: a future caller that reaches for the public `openBlockersForItem` on an await path would silently get the conservative fold scalar (every `linked-accepted` blocker reads OPEN regardless of baseline), bypassing the projection. They are correct only for `decision`/`linked-done`/`manual`. Today no production code calls them (only tests), so this is not a ship blocker.
Fix: either drop them from the public barrel (`state/index.ts`) leaving them module-private for tests, or rename to `foldOpenBlockers*` + a doc-comment "fold scalar only — NOT commit-relative; use `effectiveOpenBlockersForItem` for bucketing/await". Cheapest: a one-line JSDoc warning on `fold.ts:64,69`.

### m2 (minor) — `requireAccepted` shipped per-invocation, design said "per-workspace"
`build.ts:35` / `cli/index.ts:356` expose `--require-accepted` as a global report flag, not a per-workspace policy. Coherent and correct as a feature, but it does not yet deliver the design §6 wording. Confirm with owner that per-invocation is the intended v2.2b surface and per-workspace is a follow-up; otherwise it is an unflagged scope cut.

### n1 (nit) — no test asserts a `linked-accepted` blocker survives `assertManualResolve` rejection
`resolveBlocker` on a `linked-accepted` blocker should throw (`assertManualResolve`, `model/blocker.ts:42`). There is a test for `linked-done` rejection (`track.test.ts:155`) but none for `linked-accepted`. One-line addition.

### n2 (nit) — no end-to-end test through `buildReport`/`TrackReader` for revocation
The revocation proof uses `bucketOf` directly (`blocker-status.test.ts:71`). A test asserting an item moves AWAITED→TO-DO→AWAITED across `track.report({baselineCommit})` calls would lock the full read-path wiring (catches a future regression where a caller bypasses `bucketOf`).

### n3 (nit) — no test for the `linked-accepted` ref with zero criteria (`unknown` → stays open)
The fail-safe default (criteria-less ref ⇒ `unknown` ⇒ gate HOLDS) is implied by the `unknown` case but not asserted on a ref that has *no* criterion at all. Cheap to pin.

### n4 (nit) — `blocker-status.ts:21` `ACCEPTED_CLOSES` typed `ReadonlySet<string>`
Minor type-honesty: could be `ReadonlySet<AcceptanceStatus>` to make the strict-pass policy refactor-safe against the acceptance enum. Purely cosmetic.

---

## Summary

The implementation faithfully realizes hybrid-A. The fold/projection boundary is clean and enforced in the one place that matters (`bucketOf`), determinism and acyclicity hold, revocation is a free consequence of derive-at-read, and strict pass-only is consistent end to end. Recommend **ship**; address M1 (barrel foot-gun) and m2 (confirm `requireAccepted` scope with owner) in the next lot, and fold in the nit tests opportunistically.
