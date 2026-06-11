# ADVERSARIAL REVIEW (Opus 4.8max) — M3-prereq: under-lock clientToken dedup in EventStore.appendCommand

_Date: 2026-06-10 · Verdict: **SHIP** (no MUST-FIX; 2 SHOULD-FIX). Adjudicated by the conductor — see M3-prereq-SYNTHESIS.md._

## Angle 1 — CROSS-WORKSPACE SUPPRESSION (load-bearing)
**Scope holds in production.** Every domain aggregateId is `ulid()` (no caller-supplied/fixed id path); `newId`
is injectable but no production channel (`cli/index.ts`, `mcp/server.ts`) overrides it — only single-log tests.
The one non-ULID aggregateId is the synthetic `verification:${workspace}` which *embeds the workspace in the id*
(workspace uniquely recoverable from the suffix), so two workspaces can never share it. `(clientToken,
aggregateId)` is therefore a faithful proxy for the per-workspace `tokenIndex` namespace. No finding **in
production**; the equivalence is non-local (depends on "no channel injects `newId`").

## Angle 2 — TOKEN-REUSE-WITH-DIFFERENT-BODY (highest-stakes)
`dedupByClientToken` keys solely on `(clientToken, aggregateId)` membership and never compares the candidate's
contentHash/payload against the persisted original. A same-token/different-body retry returns the original
verbatim and drops the divergent write with no signal. Especially reachable via the stable
`verification:<workspace>` aggregate (token reuse there is a single-field client mistake). The existing ingest
`tokenIndex` is also body-blind, so this is inherited, not introduced — but this is the first under-lock
authoritative checkpoint and the place the M3 HTTP "409 on different body, same key" contract lands. **SHOULD-FIX**
(MUST-FIX if the M3 HTTP channel were landing here): recheck contentHash and throw on divergence, or document
token-uniqueness as an unchecked caller contract.

## Angle 3 — PARTIAL-MATCH / double-write
**Safe.** One command = one WorkEvent = one clientToken on the whole batch; a batch's aggregateIds are minted
together and appended atomically under the lock. A retry reuses the identical batch ⇒ either all (token,
aggregateId) pairs present (full dedup) or none (legitimate append). No subset-then-retry construction. No finding.

## Angle 4 — P0 INTERACTION
**Correct.** The dedup early-return sits before validate/framing/appendAtomic/writeHead/verifyAppend; when it
fires nothing is appended, so bypassing the AppendReceipt guard is correct. `original` is non-empty by
construction and those events passed the full P0 guard on the first write. No path returns success with neither
an append nor a genuine persisted prior event. No finding. _(Note: the conductor synthesis overrides this —
the dedup ran BEFORE the existing-log integrity validate, which Codex flagged; reordered in the fix.)_

## Angle 5 — RETURN FIDELITY + ORDERING
`dedupByClientToken` returns ALL persisted events carrying the token, gated only by "every input aggregate is
present" — it does not require the input aggregate set to EQUAL the persisted set. If a token were reused across
two separate commands (aggregate A then B), a retry of command-A-alone returns `[A,B]` — a superset (wrong
count/extra event). Production-inert today: both `appendCommand` call sites discard the return value
(`track.ts:825/827`; `emitBatch` is void), and ingest derives stable ids from its own `tokenIndex`/`resultIdOf`.
**SHOULD-FIX/NIT:** constrain the return to the input aggregate set.

## Angle 6 — FROZEN CONTRACT
**Clean.** Dedup is a pure read over `existing`; computes no hash, assigns no seq, writes no head. Zero change
to event shape/contentHash/seq/prevHash/head. Old logs replay byte-identical. `clientToken` remains additive +
hash-covered.

## Findings summary
- Angle 2 — SHOULD-FIX: body-blind dedup silently drops a same-token/different-payload retry.
- Angle 5 — SHOULD-FIX/NIT: `original` can return a superset of the input batch.
- Angles 1, 3, 4, 6 — clean (containment provably preserved in production).

## Verdict
**SHIP** — conditional on filing the Angle-2 body-divergence behavior as a tracked M3 follow-up before the HTTP
idempotency channel lands; recommend taking the Angle-5 one-line tightening now.
