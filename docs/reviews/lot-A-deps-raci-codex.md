# Lot A (deps/RACI/scope/engagementRef) — Codex (gpt-5.5 xhigh) review

Lot-1-grade review, paired with `docs/reviews/lot-A-deps-raci-opus.md`. **Verdict: ship-with-changes** →
all changes applied. Implements `M3-deps-raci-DESIGN.md` Lot A.

## Confirmed sound
- **Additive / frozen-contract:** new data is payload fields/enum values on existing event types; no
  `EVENT_TYPES` change; `canonicalize` drops `undefined`, so old events hash byte-identically; `scope` is
  emitted only for `extra` (intra blockers byte-unchanged).
- **`ref?` ripple:** the two derefs (fold `linked-done`, blocker-status `linked-accepted`) are both guarded
  `ref !== undefined`; the decision-resolution match is `kind === 'decision'` (equality, no deref). No
  authored extra blocker (ref undefined) reaches a dereference.
- **openBlocker intra/extra:** the authored path is sound (extra requires non-empty engagementRef, forbids
  ref, rejects non-manual, forces `manual`; intra/decision require a local ref).
- **RACI / ingest / CLI:** `ActorId` free string OK for a record; D6 = decision `accountable`; ingest schema
  makes `blocker.raise.ref` optional with the cross-field rule at the Track layer (right fail-closed split);
  CLI flags + USAGE wired.

## Changes applied (Codex's asks)
1. **`validateBlockerScope` completed (the single most important fix):** it now enforces the FULL
   conditional contract — decision ⇒ `ref` required; intra dependency ⇒ `ref` required; extra dependency ⇒
   no `ref`, non-empty string `engagementRef`, and `resolutionRule` absent-or-`manual`. (Was: only
   extra-ref-absence + engagementRef-presence — missing `linked-done`-extra, empty-engagementRef, and
   decision-without-ref.) Tested with 5 malformed cases + a well-formed pass, all isolating the
   `blocker-scope` finding with a valid frame.
2. **Report surfacing:** `ReportRow` now carries `accountable?`/`engagementRef?`; `DecisionRow` carries the
   sponsor `accountable?` (the design's "fold/report" surface — fold was already done).
3. **Barrel export:** `BlockerScope` exported from `src/model/index.ts`.
4. **Doc:** `v2.3b-DESIGN.md` D6 marked RESOLVED — the reserved separate `sponsor` field is superseded by
   `accountable`.

## Outcome
297 tests green; lint + build clean. Ships as 0.5.0.
