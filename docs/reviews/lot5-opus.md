# Lot 5 (report + query) — Review (Opus 4.8)

**Build:** typecheck clean; `npm test` 120/120 green; `src/events/*` unchanged.

## Confirmed faithful
- **§7 bucket precedence** (`buckets.ts`): AWAITED (any open blocker) > DROPPED (cancelled/rejected) > DONE (done, +pass iff requireAccepted) > TO-DO. Decision exclusion structural (iterates `state.items` only). done+open-blocker→AWAITED, rejected/cancelled→DROPPED tested.
- **requireAccepted**: demotes done-not-pass; default false; `baselineCommit` required (CLI HEAD default correctly deferred to Lot 6/7 — read layer must not invent "current").
- **Priority sort** (`build.ts byPriority`): WSJF score desc, unprioritized after, id tie-break — total, no NaN/throw.
- **Decision view**: `--decisions` maps to DecisionRow; absent by default; never in item buckets.
- exactOptionalPropertyTypes respected.

## Findings
- **minor** `build.ts` `query` — `QueryFilter.kind: ItemKind` includes `'decision'`, but query flattens non-decision buckets only → `query({kind:'decision'})` silently returns `[]`. Fix: narrow query-kind to non-decision kinds (compile error), or route to the decision view. Lot 6 CLI would inherit a dead filter value.
- **nit** `format.ts` — raw titles in text/md; a title with `\n` or markdown metacharacters can inject fake headings/rows or break formatting (JSON is safe). Normalize newlines + escape md metacharacters.
- **nit (spec-clarity)** done+requireAccepted+not-pass → TO-DO is the only residual bucket (§7.4 "otherwise"); honest (row carries realization+acceptance) but worth a one-line SPEC note.

## The two known open semantics — acceptable reversible defaults
(a) linked-done dep whose ref ends cancelled/rejected → target AWAITED forever: faithful to §2.9 (no clause for a dead ref); AWAITED invites attention rather than masking. Reversible; changing it touches the fold layer, out of Lot-5 scope.
(b) no-go on already-done target → stays done → reports DONE, gate completed: internally consistent (retro-rejecting `done` is itself illegal per §2.3; rejecting the whole no-go would make the decision un-settleable). Honest reflection of realization. Reversible; already flagged.

No blockers, no majors. Faithful to §7/§6/§2.4.

**VERDICT: SHIP**
