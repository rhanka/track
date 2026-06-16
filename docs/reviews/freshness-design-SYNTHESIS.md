# acceptance-freshness-lifecycle design — pair-review synthesis (Codex + Opus CONVERGED)

**Date:** 2026-06-15 · **Verdict (both): SPEC-READY-WITH-CHANGES.** Root-cause + the git-agnostic skill boundary
+ the single additive `realization.anchored` kind + terminal-DONE-without-a-new-state are all CONFIRMED correct.
But the draft is **not buildable as written** — the pair converged on the same MUST-FIX and a cleaner shape.

## CONFIRMED (both, verified in code)
- Root cause: `accept/status.ts:25` literal `run.commit !== baselineCommit`; `baselineCommit` = the moving global
  HEAD (`cli/index.ts` `resolveCommit→gitHead = git rev-parse HEAD`). Treadmill reaches BUCKETING:
  `buckets.ts:27` `requireAccepted && acceptanceStatus !== 'pass' ⇒ TO-DO` regresses a done item out of DONE.
- 0.10.8 orthogonal (normalized `HEAD`→SHA at both ends; `status.ts` untouched).
- track records NO realization commit today (`realization.transition` payload `{to}` only); only `acceptance.run`
  carries a commit. Git ancestry MUST stay in the skill (`TrackReader` holds no git — a core invariant).

## THE KEYSTONE (both MUST-FIX): equality ⊊ ancestry; SQUASH/REBASE defeat a naive anchor
`fresh-at-anchor` = `run.commit === realizedCommit` is string-equality, but freshness is an ANCESTRY relation
(the run commit must INCLUDE the anchor: `git merge-base --is-ancestor <anchor> <run.commit>` — Codex corrected
the direction). The two distinct questions the draft conflated:
- **Q1 "is acceptance still valid (unchanged code)?"** — compare `run.commit` to the item's OWN anchor, not the
  global HEAD. An unrelated merge moves neither ⇒ stays fresh. **This is the treadmill fix** and it holds even
  under squash (the item's own branch commit is BOTH its anchor and its run commit).
- **Q2 "is acceptance valid at CURRENT main HEAD?"** — needs ancestry to HEAD. **Squash/rebase break this**: the
  branch run commit is discarded, a new SHA lands, and the run commit is not an ancestor of the squash. Equality
  AND the skill's ancestry call both fail. The ONLY heal is recording an `acceptance.run --commit <mergeCommit>`
  at consolidation (the existing append-only `recordRun`, `track.ts:614`) — but that is an **evidence ASSERTION**
  (the merging agent claims the squash preserves the green tree; no test ran at that commit).

## THE CLEANER SHAPE (Codex, both endorse) — keep AcceptanceStatus STRICT, freshness as a read DETAIL
Do NOT grow `AcceptanceStatus`. Keep it `pass|fail|unknown|stale|waived|n/a`. This SIDESTEPS two breakages the
draft introduced: the two hand-maintained `ACCEPTANCES` enum copies (`cli/index.ts:108`, `mcp/server.ts:25`) and
the `buckets.ts:30 !== 'pass' ⇒ TO-DO` regression. Anchor freshness (run-SHA + anchor-SHA + a track-decidable
equality + a `needs-ancestry` fail-closed flag) is exposed as a NEW READ DETAIL the skill consumes; the public
gate semantics (`requireAccepted`, linked-accepted) stay strictly `pass`. The treadmill is then healed at the
SKILL/consolidation layer (re-stamp `acceptance.run` at the merge commit), not by mutating track's status enum.

## MUST-FIX list (converged) — for the design revision
1. **Squash/rebase heal is MANDATORY, not optional:** consolidation MUST append `acceptance.run --commit
   <mergeCommit>` for non-ancestor merge modes; confront the evidence-fiction (owner call below).
2. **Keep AcceptanceStatus strict;** freshness/anchor = a read DETAIL, not a status value (sidesteps the enum
   copies + the bucket regression).
3. **Expose the read surface** the skill needs: run-SHA + anchor-SHA on the acceptance detail (today `ReportRow`
   exposes only `acceptance` — `build.ts:10`). Add acceptance detail on rows or a criterion/evidence detail method.
4. **`realization.anchored`:** explicit fold case (the fold ignores unknown kinds — `fold.ts:197/371`); last-anchor
   authoritative; `item.consolidate` carries `clientToken` (dedup re-consolidation); restrict to real items.
5. **Backlog healing eligibility** can't use global-HEAD acceptance (that's the bug): consolidate takes EXPLICIT
   item-IDs from the skill (caller-authoritative, unvalidatable by track — no branch→item link exists,
   `branch.imported` not folded `fold.ts:371`), OR "done + latest runs pass at THEIR OWN commits".
6. **Contract:** new kind `realization.anchored` + new WorkEvent `item.consolidate` + optional anchor on the read
   detail; INGEST 1.1.0→1.2.0, READ 1.9.0→1.10.0; update the snapshot tests; anchorless-log byte-identity
   regression test. NIT: drop the optional `acceptance.consolidated`/`item.realize.commit` — use ONLY
   `realization.anchored` + existing `acceptance.run`.

## OWNER QUESTIONS (pair recommendations in parens)
- **CRUX — squash/rebase evidence policy:** is recording `acceptance.run --commit <mergeCommit>` at consolidation
  (an equivalence ASSERTION by the merging agent, not a fresh test run) acceptable under track's `settles:'evidence'`
  model? (Both: YES — it's the only heal; the alternative is content-equivalence inference, worse. The merging
  agent's identity/prov is recorded, so it's an attributable attestation, consistent with "track records, never
  verifies".)
- Keep `AcceptanceStatus` strict, freshness as detail? (Both: YES.)
- Latest `realization.anchored` authoritative (priors = audit)? (Both: YES.)
