# Adversarial Review — Lot 1 (frozen event contract) of `@sentropic/track`

Scope reviewed: SPEC §3/§4/§8, PLAN Lot 1, `src/events/{canonical,types,frame,store,validate}.ts`, `src/state/{fold,snapshot}.ts`, the four test files, vs h2a `journal.ts` / `canonical.ts`.

## On the two flagged design decisions

**Decision 1 — contentHash domain = `EventCore` (everything but `{seq,prevHash,contentHash}`).** Correct call, and the *right* reading of SPEC §3 despite the literal wording. The literal `sha256(canonicalJSON(payload))` is under-specified to the point of being unsafe: hashing only the nested `payload` would leave `type`/`aggregate`/`aggregateId`/`by`/`at`/`id`/`cmdId`/`cmd` tamper-free, and would make `contentHash` non-unique (two `item.created` with identical payloads collide), which breaks `prevHash` as a positional reference. The chosen `stripFrame` domain is faithful to h2a (`journal.ts:36`) and closes that hole. **Keep it — but the SPEC text is now wrong and must be amended before freeze (see SPEC-DRIFT below).**

**Decision 2 — `cmd:{i,n}` frame field.** Sound and minimal. SPEC §3 / A5 explicitly require "a partial batch (a `cmdId` missing an expected member) is flagged," and a bare `cmdId` provably cannot detect a dropped *trailing* member (chain + per-aggregate seq stay consistent — `validate.test.ts:99-107` demonstrates exactly this). `cmd.{i,n}` is covered by `contentHash`, so `n` itself is tamper-protected per surviving member. This is the correct way to satisfy A5. No conflict with SPEC/PLAN. **Keep it.** (One residual hole noted under MAJOR-2.)

## Findings

**[BLOCKER] Tail truncation of whole commands is undetectable — no global stream anchor.** `validate.ts:42-94` + `types.ts:63-67`. h2a uses a global, 0-based, exact-+1 `sequence` over the entire journal (`journal.ts:99-106`). Track replaced this with per-aggregate `seq` and no global stream position field at all. Consequence: deleting the final N events of the stream (or the final whole `cmdId` batch) leaves every surviving event with a valid `prevHash` chain *and* contiguous per-aggregate `seq` *and* complete surviving batches → `validate` returns `ok:true`. For a frozen system-of-record that is the worst class of undetected loss. **Fix:** add a global monotonic stream position to the frame, and/or an anchored head manifest; doing this *after* freeze means rewriting every persisted event.

**[MAJOR-1] Whole-batch (or whole-aggregate-tail) deletion is undetectable even with `cmd:{i,n}`.** Same root cause as the BLOCKER (no external/global anchor): if *all* members of a batch are removed, the `cmdId` vanishes and nothing references it.

**[MAJOR-2] `validate` trusts `cmd.n` blindly and cannot distinguish a single-event command from a 1-member batch.** `store.ts:54` only emits `cmd` when `inputs.length>1`; `validate` has no cross-check that a batch's declared `n` is consistent across members. Document that `cmd` is an availability/repair aid, not a tamper defense — but pair it with the global anchor so re-chaining is detectable.

**[MAJOR-3] `appendCommand` re-reads and re-folds the entire log on every call — a correctness risk, not just perf.** `store.ts:59-66`. (a) `readAll` throws on any malformed line (`store.ts:34`), so a single torn line anywhere bricks all future appends. (b) The per-aggregate seq derivation counts *occurrences* rather than reading the last event's `seq+1`; this diverges from `validate`'s authority if the log was ever hand-edited. **Fix:** derive next seq from `max(seq)` of matching `aggregateId`; consider a tolerant read path.

**[MAJOR-4] Torn-write / crash recovery is claimed atomic but is not crash-safe.** `store.ts:86-96`. A single `writeSync` of a multi-line buffer is not guaranteed atomic across a crash, and `writeSync` may short-write (return value ignored). **Fix:** loop on `writeSync`'s byte count; document the recovery procedure and tolerate exactly one trailing torn line rather than hard-throwing.

**[MINOR-1] SPEC-DRIFT: §3 frame text does not match the frozen implementation.** SPEC §3 (`SPEC.md:212`) still reads `PAYLOAD ONLY`, and the §3 diagram (`SPEC.md:71`) says `contentHash(payload)`; `cmd:{i,n}` is absent. **Fix:** amend SPEC §3 frame + diagram and add `cmd?:{i,n}`.

**[MINOR-2] Canonicalization edge cases are frozen forever — pin them with tests.** `null` vs absent, `-0`, integers beyond 2^53, non-ASCII. None break Lot 1 but add tests so a future refactor can't drift the hash.

**[MINOR-3] `fold` mutates `AggregateProjection.history` in place; `serializeState` returns live refs.** `fold.ts:37-38`, `snapshot.ts:21-23`. Minor for Lot 1. The broader "freeze the mechanism while the State shape grows" claim is correct and well-isolated.

**[NIT-1] Empty-stream and single-event streams validate trivially `ok:true`** — add explicit degenerate-case tests.

**[NIT-2] `seq` exclusion from `contentHash` is adequately protected given the chain, but only positionally** — fine once a global anchor lands.

## Summary

Decision 1 (hash domain) is correct and faithful; Decision 2 (`cmd:{i,n}`) is sound for *partial*-batch detection. The integrity model is weaker on **tail/whole-batch truncation** (no global anchor), atomicity is overclaimed, a single bad line bricks appends, and the SPEC text no longer matches what is frozen. These are painful to change after freeze, so resolve before freezing.

**VERDICT: CHANGES-REQUIRED**
