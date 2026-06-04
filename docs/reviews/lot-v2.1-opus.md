# Lot v2.1 (M2a) — CI→acceptance ingest IDEMPOTENCY — adversarial review (Opus 4.8)

Scope: `Track.ingestRuns` dedup (src/track.ts), accept idempotency tests (src/accept.test.ts),
report parser (src/accept/ingest.ts), reusable CI workflow (.github/workflows/track-acceptance.yml),
PLAN-v2 Lot v2.1. Read-only review; no source modified.

**VERDICT: ship-with-changes.** One MAJOR correctness bug (5-tuple is not flap-idempotent → wrong
`latestRun` after a real pass→fail→pass on one commit), plus a workflow `uses:` slug that does not
match the published package, and a test-coverage gap that hides exactly the failing case. None touch
the frozen frame/hash/chain; the append-only contract is intact. Fixable inside the lot.

---

## 1. Dedup-key correctness — 5-tuple (incl `result`) vs PLAN's 4-tuple

### [MAJOR] The 5-tuple is NOT idempotent under a same-commit result flap — `latestRun` becomes wrong.
`src/track.ts:362-363,383-384`. The key is `(evidenceId, commit, env, runner, result)`; `seen` is
seeded from the WHOLE existing log (`store.readAll()` filtered to `acceptance.run`), so a key once
recorded is forever suppressed. Fold takes **latest-in-stream-order** as `latestRun`
(`src/state/fold.ts:181-200`). Combine the two on a flaky test, SAME commit `c1`:

1. ingest `pass` → key `…|pass` new → appended. `latestRun = pass`.
2. ingest `fail` → key `…|fail` new → appended. `latestRun = fail`.
3. ingest `pass` (test recovered) → key `…|pass` **already in `seen`** → **DROPPED**.
   `latestRun` stays `fail`.

Result: the criterion reports **fail** while the latest real run on `c1` was **pass**. That is a
false-negative acceptance state on a real, distinct run — strictly worse than the MVP's
append-everything behaviour, which at least recorded the recovery. The dedup is meant to suppress
*identical re-ingests*; here it suppresses a *legitimate state-restoring run* because an
earlier-but-superseded run carried the same result value.

Symmetrically fail→pass→fail leaves `latestRun = pass` after a real regression — a false **green**,
which is the more dangerous direction for a gate.

This is exactly the case the prompt asked to stress, and it is the deviation from PLAN's documented
4-tuple `evidenceId+commit+env+runner` (`docs/plan/PLAN-v2.md:47`). The 4-tuple is *also* not
flap-correct (it would drop ingest #2's fail), so the PLAN key is not the fix — **but the
implementation silently chose a different key than the PLAN without recording the rationale or its
own failure mode.** Judging the deviation: adding `result` is a net improvement over the 4-tuple
(it at least records the first transition), but it is still wrong on the *second* recurrence of a
prior result, and the divergence is undocumented.

**Concrete fix (pick one, record the choice):**
- **(preferred) Dedup against the LAST run for the (evidenceId,commit,env,runner) tuple only, not
  the whole history.** Build `seen` as a `Map<4-tuple, lastResult>` by scanning the log in order;
  a candidate is a duplicate iff `lastResult === entry.result`. Then pass→fail→pass records all
  three (each differs from its immediate predecessor), latest-wins is correct, and a true identical
  re-ingest (same trailing result) is still a no-op. This satisfies both "re-ingest is stable" and
  "flap is faithfully recorded".
- **(alternative, simpler) Sequence/idempotency token per ingest:** if CI re-runs are the only
  duplication source, dedup on `(evidenceId,commit,env,runner)` **per report invocation** (within
  batch only) and accept that an unchanged-result re-run of the same commit appends one no-op event
  — but that breaks the "re-ingest leaves event count stable" gate, so it is inferior here.
- At minimum, if the 5-tuple is kept, **document the flap limitation** in the method comment and add
  the failing test below so the behaviour is a conscious contract, not an accident.

### [MINOR] `env`/`runner` in the key are sourced from CLI flags, not the report.
`src/track.ts:354,362`. All entries in one ingest share the same `run.{commit,env,runner}` (they are
invocation-level, not per-testcase). So the key effectively reduces to `(evidenceId, result)` within
a single CI invocation — fine — but two pipelines ingesting the same commit under different `env`
labels (`ci` vs `ci-rerun`, or a default that drifts) will both record, doubling events for what is
logically one result. Not a blocker (latest-wins still resolves status), but note it: idempotency is
only as stable as the `env`/`runner` labels the workflow passes, and the workflow defaults `runner`
to `ci` (`track-acceptance.yml:36`) while the CLI default is `cli` (`cli/index.ts:307`) — a
hand-run vs CI ingest of the same commit will NOT dedup against each other.

---

## 2. Existing-log scan soundness — `unknown` payload join vs typed key

### [NIT] Stringification is consistent today, but the key build is type-unsafe by construction.
`src/track.ts:367-374` builds the existing-key from `unknown` payload fields
(`[p.evidenceId, p.commit, p.env, p.runner, p.result].join(SEP)`); the candidate key
(`runKey`, line 362) joins typed strings. For a well-formed `acceptance.run` every field is always a
string (`recordRun`/`ingestRuns` only ever write strings — model `RunPayload`), so today there is no
coercion mismatch: `result` is `'pass'|'fail'` on both sides, no number/boolean ever flows in.
However `Array.prototype.join` coerces `undefined`/`null` to the empty string, so a malformed legacy
event with a missing field would key as `…||…` and could **false-hit** a genuine run whose
evidenceId happened to be empty — purely theoretical given the writers, but the asymmetry (`unknown`
join vs typed join) is a latent trap if a future event type reuses `acceptance.run` loosely.
**Fix:** guard the scan with `typeof p.evidenceId === 'string' && …` (skip non-conforming rows), or
reuse a single `runKey`-style builder for both sides so they cannot drift.

---

## 3. Within-batch dedup + multi-evidence-per-locator

### [PASS] N evidence on one locator still records N runs.
`src/track.ts:379-398`. The key is per-`evidence.id`, so a locator shared by N evidence yields N
distinct keys → N runs, and the within-batch `seen.add` only collapses a *repeat of the same
evidence+result*. Verified against the existing test "records a run for ALL evidence sharing a
locator" (`src/accept.test.ts:156-165`, expects `2`) and the new within-report dedup test
(`:222-231`, two identical loc1 entries → `1`). Correct. The inner `for (evidence of …)` re-iterates
the full evidence map per report entry — O(entries × evidence) — acceptable at MVP scale; note only
if logs grow large.

---

## 4. Append-only / frozen-contract safety

### [PASS] No frame/hash/chain contact; batch atomicity and single-cmdId preserved.
`ingestRuns` only assembles `EventPart[]` and calls `emitBatch` (`src/track.ts:401`), which is the
same path every other command uses. `emitBatch` (`:576-592`) tags a multi-event command with one
`this.newId()` cmdId and a single-event command standalone — unchanged. `seq`, positional
`prevHash`, `contentHash` are assigned solely by `EventStore.appendCommand`
(`src/events/store.ts:75-98`), which `ingestRuns` does not touch. Returning `0` and skipping
`emitBatch` when `parts.length === 0` (`:400`) is correct and preserves invariants — it avoids the
`appendCommand` empty-command throw and writes nothing, so a fully-deduped re-ingest is a genuine
no-op (event count stable, head unchanged). Good.

### [NIT] Read-then-write race is unchanged from MVP (single-writer assumption).
`seen` is built from `store.readAll()` (`:365`) and `state` from an earlier `readAll` (`:356`); a
concurrent writer between the scan and `appendCommand` could let a duplicate slip in. This is the
documented single-writer contract (SPEC §3, store header), not a v2.1 regression — out of scope, but
worth a line in M4's concurrency ledger.

---

## 5. Separator safety — `String.fromCharCode(0)` (NUL)

### [PASS, with one caveat] NUL is a sound separator for the controlled fields.
`commit`, `env`, `runner` are CLI flags / git SHA; `evidenceId` is a ULID; `result` is an enum —
none can legitimately contain a NUL byte, so cross-tuple collision via separator injection is not
reachable through the supported surface. `locator` (the one user-influenced free-text field) is NOT
part of the key, which removes the only realistic injection vector. **Caveat:** nothing *enforces*
NUL-absence — a future field added to the key from report content (e.g. a per-testcase `env`) would
reintroduce the risk. Cheap hardening: assert/escape, or note the invariant in the comment. Minor.

---

## 6. Workflow correctness

### [MAJOR] `uses:` slug points at `rhanka/track`, but the package and homepage are `@sentropic/track` / not a verified workflow path.
`.github/workflows/track-acceptance.yml:11` documents `uses: rhanka/track/.github/...@main`. The
package is `@sentropic/track` (`package.json:2`) and homepage `github.com/rhanka/track`
(`package.json:7`) — so the org/repo is `rhanka/track` while the npm scope is `sentropic`. The
example is at least internally consistent with `package.json.repository`, BUT a consumer copy-pasting
it gets a reusable-workflow reference that only resolves if that exact repo+path+ref is public. If
the intended public handle is `sentropic/track` (matching the npm scope and the rest of the docs),
this is a broken example. **Fix:** confirm the canonical `owner/repo` and make the `uses:` slug,
`homepage`, and npm scope tell one story; pin `@main` to a tag for reproducibility.

### [MINOR] The step invokes a real CLI surface, but failure modes are undocumented and silent.
The command (`:54-61`) maps 1:1 to the CLI: `accept run --from --format --commit --env --runner`
(`src/cli/index.ts:43,304-313`) — flags and `--format junit|json` (`FROM_FORMATS`, `:65`) all exist.
Good. But:
- **No `.track/` present** → `readFileSync` of the report succeeds yet `ingestRuns` finds zero
  evidence (empty state) and prints `ingested 0 run(s)`, **exit 0**. A consumer who forgot to commit
  the sidecar gets a silent green. Document the precondition (sidecar committed) and consider a
  `--require-match`/non-zero-on-zero opt-in.
- **Locator mismatch** (test names ≠ evidence locators) → same silent `0`. This is the single most
  likely real-world failure and is invisible. At minimum the workflow comment should say "0 ingested
  ⇒ check locator↔test-name alignment", ideally surface a count assertion.
- **No commit/push step** — the workflow ingests into `.track/events.jsonl` in the runner checkout
  but never persists it. As written it is a *validation* of ingestability, not a durable feed; if the
  intent is to record runs back to the repo, a commit/push (or artifact) step is missing. Clarify the
  deliverable: dry-run check vs. persisted feed.
- `npx -y @sentropic/track@latest` (`:55`) floats `latest` by default — fine for the example, but the
  dogfood CI should pin.

### [NIT] Header comment claims dedup on the 4 invocation fields + result but PLAN says 4-tuple.
`track-acceptance.yml:4` advertises `evidenceId+commit+env+runner+result` (the real 5-tuple) — so the
yaml matches the code, not the PLAN. Reconcile the PLAN line (`PLAN-v2.md:47`) to the shipped key (or
vice-versa per finding #1) so the three artifacts agree.

---

## 7. Test adequacy

### [MAJOR] Idempotency is proven; the flap regression that breaks it is NOT tested.
`src/accept.test.ts:189-232` covers: re-ingest no-op (`:200`), single result change pass→fail
(`:209`), new commit not deduped (`:216`), within-report dup collapse (`:222`). These prove
*idempotency on identical input* and *first transition* — but there is **no pass→fail→pass (or
fail→pass→fail) on the same commit**, which is precisely the case that exposes finding #1. The suite
therefore certifies green a behaviour that is wrong. Add (and currently it would FAIL, documenting
the bug):

```ts
it('a flaky test recovering on the same commit reports the latest result (pass)', () => {
  const c = evidenceOnLoc1()
  track.ingestRuns(report('pass'), 'json', run('pass'))
  track.ingestRuns(report('fail'), 'json', run('fail'))
  expect(track.ingestRuns(report('pass'), 'json', run('pass'))).toBe(1) // recovery is a real run
  expect(criterionStatus(track.state(), c, 'c1')).toBe('pass')          // latest wins, not stuck fail
})
```

### [MINOR] Missing coverage the lot's own gate implies:
- **JUnit re-ingest idempotency.** Every idempotency test uses JSON (`report()` builds JSON only,
  `:195-196`). The CI bridge defaults to `junit` (`track-acceptance.yml:27`); the dedup path is
  format-agnostic but the *parser* differs — add one junit re-ingest no-op to cover the real CI
  format end-to-end.
- **Stale-vs-baseline interaction with dedup.** PLAN gate names "`stale` vs `baselineCommit`"
  (`PLAN-v2.md:48`). There is a stale test in the older block (`:57-63`) but none combining a
  deduped re-ingest at an old commit with a fresh baseline. Add: ingest at `old-commit`, re-ingest
  identical → `0` new events AND status `stale` (proves dedup doesn't mask staleness).
- **Multi-evidence dedup across calls.** The shared-locator test (`:156-165`) is single-call; no test
  that re-ingesting the same report for N-shared evidence is a no-op for all N (each per-evidence key
  already in `seen`). One line of extra coverage closes the "records N, re-records 0" loop.
- **`env`/`runner` participate in the key.** No test varies `env` or `runner` to prove they
  discriminate (or, per finding #1.MINOR, to expose the CI-vs-CLI default mismatch). Add one ingest
  with `env:'ci'` then `env:'ci-rerun'` same commit/result → currently `1` then `1` (both recorded),
  pinning the chosen semantics.
- **Empty / no-match report.** `accept run --from` on a report whose locators match nothing → `0`,
  no events — covers the workflow's silent-green failure mode at the unit level.

### [PASS] Non-regression of prior behaviour.
The pre-existing ingestion tests (`:123-187`) are untouched and still assert match-by-locator,
skip-omission, CDATA safety, multi-evidence fan-out, and decision-`n/a`. Dedup is additive and does
not regress them.

---

## Severity ledger
- **MAJOR** — 5-tuple not flap-idempotent → wrong `latestRun` after same-commit pass→fail→pass
  (false fail) or fail→pass→fail (false green). `src/track.ts:362-384`. Fix: dedup on *last result
  per 4-tuple*, not whole-history-by-5-tuple.
- **MAJOR** — workflow `uses:` slug `rhanka/track` vs npm scope `@sentropic/track`; confirm canonical
  owner/repo, pin ref. `.github/workflows/track-acceptance.yml:11`.
- **MAJOR** — test suite proves idempotency but omits the flap case that breaks it; add the failing
  pass→fail→pass test. `src/accept.test.ts:189-232`.
- **MINOR** — `env`/`runner` key fields are invocation-level; CI default `runner:ci` ≠ CLI default
  `cli` → hand-run vs CI won't dedup. `cli/index.ts:307` vs `track-acceptance.yml:36`.
- **MINOR** — workflow silent-green on missing `.track/` or locator mismatch; no persistence step.
- **MINOR** — missing tests: junit re-ingest, stale+dedup, multi-evidence re-ingest, env/runner
  discrimination, empty-report.
- **NIT** — existing-key built from `unknown` join vs typed candidate key; guard types / share a
  builder. `src/track.ts:367-374`.
- **NIT** — NUL separator safe today but unenforced; risk returns if a content-derived field enters
  the key.
- **NIT** — PLAN says 4-tuple, code+yaml use 5-tuple; reconcile the three. `PLAN-v2.md:47`.

## What's correct (don't regress fixing the above)
- Append-only / frame / hash / chain untouched; `emitBatch` atomicity + single cmdId intact;
  `parts.length===0 ⇒ return 0` is a true no-op (event count + head stable).
- Per-evidence keying preserves N-runs-for-N-shared-evidence.
- `result` participates so the *first* same-commit transition is recorded (improvement over PLAN's
  4-tuple) — the bug is only on a *recurrence* of a prior result.
- Parser unchanged; skip/CDATA/empty-locator omission still hold.

**VERDICT: ship-with-changes** — land the last-result-per-tuple dedup (or, if the 5-tuple is kept by
decision, document the flap limitation), add the flap + junit-re-ingest tests, and fix the workflow
`uses:` slug + silent-green note before tagging the CI bridge as the v2.1 deliverable.
