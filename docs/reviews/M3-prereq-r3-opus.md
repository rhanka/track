# FINAL CONVERGENCE REVIEW (round 3, Opus 4.8max) — track concurrent-retry idempotency seam (Option B)

_Date: 2026-06-11 · Verdict: **SHIP** (no remaining MUST-FIX). Pair CONVERGED._

Verified against real source (store.ts, track.ts, ingest.ts, both test files), not the summary. 583 tests pass,
typecheck exit 0, build exit 0 — reproduced locally.

**1. CONCURRENT CREATE-RETRY → ONE event, FIRST's persisted id — RESOLVED.**
ingest.ts injects `workspaceDedupe(cmd.clientToken, ctx.workspace)` for tokened commands; the hook keys on
`(clientToken, eventWorkspace)`, independent of the re-minted aggregateId. Under the lock it runs after F3
validate, returns the originals, appends nothing. Result id flows from the persisted event (createItem,
createDecision = parts[0]⇒persisted[0], openBlocker). Proven by the stale-until-lock tests (item.created,
decision, blocker.raise: `created===1`, `r2.ids[0]===firstId`). `StaleUntilLockStore` flips `inAppend` around
the super call — every pre-append view stale, only the in-lock re-read current ⇒ the under-lock recheck is the
sole dedup. Cannot double-write.

**2. RESULT-ID FIDELITY across all id-returning facades — RESOLVED.**
`grep -E "return .*Id\b"` on track.ts returns ZERO direct minted-id returns: every site derives from the
persisted event with the minted id only as `?? fallback` (unreachable on a successful append/dedup, both
non-empty). createItem/createDecision/openBlocker (aggregateId); addCriterion/linkEvidence (payload
criterionId/evidenceId); resolveExternalDependency (existing-aggregate ids). No facade still returns a minted id.

**3. NAMESPACING BY CONSTRUCTION — RESOLVED.**
workspace is IN the hook key (`eventWorkspace(e,state)===workspace`), resolved by aggregate identity from
folded state — holds even if two workspaces shared an aggregateId. Same-token/different-workspace still appends.
Tokenless ⇒ NO hook installed; store default `dedupByClientToken` also early-returns null on absent token.

**4. eventWorkspace SOUNDNESS — RESOLVED.**
`IngestContext.workspace` typed `string`, always defined. The match is a conjunction (token AND workspace), so
an event whose workspace resolves to `undefined` can NEVER equal a defined string ⇒ never wrongly
matched/suppressed. Synthetic `verification:<ws>` parsed from the suffix ⇒ resolves to its real workspace.
Decision aggregates resolve via folded `workspace`. No undefined-resolving event can be suppressed.

**5. F1–F4 + default store hook — RESOLVED.**
F3 validate-before-dedup intact (throws `/invalid log/` on tampered-but-duplicate). F4 exact-set faithful
return (Case B returns exactly the input aggregates' events in stream order). F1 workspace-blind store / F2 no
body compare documented + intact. Default `(clientToken,aggregateId)` Case A/B/C unchanged for direct callers;
Case C partial-overlap throw preserved. The default fires only when `opts.dedupe` absent.

**6. P0 + FROZEN contract — RESOLVED.**
Dedup early-returns already-persisted originals before framing/append/verifyAppend — correct: P0 governs new
appends; on a dedup nothing is appended and originals were verified at their own write, while F3 guarantees no
rc=0 on a corrupt log. Frozen-contract files (canonical/frame/validate/head/types) untouched ⇒
shape/hash/seq/prevHash/head byte-identical; the hook is a pure read.

Both round-2 residual MUST-FIX (concurrent create-retry double-write; deduped retry returning a never-persisted
minted id) closed by construction and by passing adversarial stale-until-lock tests. No remaining MUST-FIX.

**VERDICT: SHIP.**
