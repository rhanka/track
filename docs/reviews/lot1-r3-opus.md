# Round-3 Adversarial Freeze Review — Lot 1 of `@sentropic/track`

**Gate:** `npm run typecheck` clean; `npm test` = **43/43 green** (6 files).

## Round-2 fix verification

**FIX 1 — `canonical.ts` direct-string emission (the twice-defective hash domain): CORRECT and COMPLETE** across the vectors tested: `__proto__` own key (covered, hashed, tamper-detected), nested `__proto__`/`constructor`/`prototype`, numbers (`-0`→`0`, `1e21`, `2^53+1`, `5e-324`, `MAX_VALUE` all match `JSON.stringify`), `toJSON` rejected (correct for a frozen SoR), non-plain `Date`/`Map`/class rejected, enumerable getter / deep nesting / non-ASCII / emoji / lone surrogate / exotic-escaped keys / empty containers / top-level scalars all stable across persist→reparse. Deliberate, documented divergence from h2a (which silently drops `__proto__` and hashes `Date` as `{}`).

**FIX 2 — `store.ts` full-candidate validation: CORRECT.** `validate([...existing, ...events])` before `appendAtomic`. An intra-batch aggregate-type collision and a single event reusing an aggregateId under a new type are both rejected, nothing persisted.

**FIX 3 — `head.ts` resilience: CORRECT.** `readHead` → `null` on missing/malformed; `writeHead` temp+fsync+rename atomic. Corrupt head tolerated; forged valid head with wrong anchor refuses appends with `head-mismatch` and recovers on head deletion; stale head tolerated.

**FIX 4 — SPEC §3: CONSISTENT** (diagram `core-hash + prevHash + seq + head`; frame text + §4 match code).

## Findings

**[MINOR] Double full-stream validation per append (perf only) — `store.ts:65` + `store.ts:98`.** `existing` (with head), then `existing + events` (without head); O(n²) over the stream lifetime. Correct, acceptable for single-writer local n. Post-MVP: validate the prefix once and incrementally check the appended tail. Not freeze-blocking.

**[NIT] `undefined` inside a payload array is rejected, not normalized — `canonical.ts:56`.** Not a hash≠persist divergence (fail-closed before write) and faithful to h2a. Worth a one-line SPEC note.

**[NIT] SPEC §3:215 omits the `toJSON` rejection.** Cosmetic doc completeness.

## Frozen-contract assessment

Event frame, contentHash domain (= `EventCore` via `stripFrame`, h2a-faithful), positional `prevHash` chain, per-aggregate 1-based contiguous `seq`, `cmd:{i,n}` batches, `validate` (content/reorder/drop/dup/aggregate-mismatch/partial-batch + head truncation), the non-authoritative rebuildable head anchor, and the pure `fold` mechanism are internally consistent and safe to build later lots on. Truncation gap correctly closed by the head anchor (a global `streamSeq` would not detect suffix truncation — confirmed against h2a's `verifyJournalChain`).

No blocker or major. The two prior-round hash-domain defects are genuinely resolved.

**VERDICT: FREEZE-OK**

---
_Round-3 note: Codex (parallel reviewer) additionally found that **sparse arrays** (`[,1]` hashes divergently from the persisted `[null,1]`) and **enumerable accessors** are still accepted by `canonicalize` — a real (programmatic-only) hash≠persist divergence this review missed. Tightened before freeze; see lot1-r3-reconciliation.md._
