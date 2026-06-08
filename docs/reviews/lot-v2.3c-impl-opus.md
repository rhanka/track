# Lot v2.3c IMPLEMENTATION (ingest idempotency) — Opus 4.8 review

Adversarial Lot-1-grade review, paired with `docs/reviews/lot-v2.3c-impl-codex.md`. **Verdict:
ship-with-changes.** The contract change is genuinely additive/frozen-safe, scoping leak-free, stable-id
recovery correct for every kind — the one non-acceptable-to-leave-silent issue was the **global token
namespace**, now fixed.

## Confirmed sound (verified against canonical/frame/validate/fold)
1. **Additivity:** `EventCore.clientToken?` is structurally identical to `prov?`; `canonicalString`/
   `materialize` skip `undefined`, so a no-token event hashes byte-identically to a pre-v2.3c event. Fold
   unchanged (it's a delivery key, not domain state). Hash-covering is load-bearing: a token edited in the
   log yields a `content-hash` finding and `appendCommand` refuses to extend — so a silent skip/replay flip
   is detectable.
2. **`withClientToken` scoping:** scoped mutable set/finally-restore; stamps every event of exactly one
   command's batch; no leak across commands (top-level `prev` is undefined); ingest never nests; fully
   synchronous ⇒ no reentrancy hazard. Verified every ingest-reachable method emits exactly one `emitBatch`.
3. **Skip + stable ids:** `resultIdOf` recovers the original return for every create-like kind
   (item/decision/blocker → aggregateId; criterion/evidence → payload id) and null otherwise; first event
   of `decision.create`'s batch is `decision.created` ⇒ returns the decisionId. Skip-before-authorize is
   safe (writes nothing).
5/6/7. Intra-stream dup, untokened at-least-once, and the deferred concurrent-race + non-atomic-loop
   boundary all sound/accurately stated.

## The hole (#4) — FIXED
The token index was built from the WHOLE log, unscoped by workspace: a W-pinned channel presenting a token
V had used would skip (no write) and return V's id — a cross-tenant **write-suppression** vector once M3
admits multiple principals (M3's structured `requestId#index` tokens on a shared namespace make it
predictable), and the "ULID already enumerable" bound breaks under M3 per-workspace read scoping.
**Fix applied:** the index is now keyed on the affected aggregate's workspace (resolved from the fold), so
a V token cannot suppress or disclose to W. Regression test added (V/W identical token ⇒ W write proceeds,
returns W's own id).

## Other changes applied (Opus's test gaps)
Tokened `decision.create` wholesale-skip; tokened no-go batch skip; stable-id for blocker/evidence retries;
the cross-workspace-collision test pinning the per-workspace semantics. Design doc updated.

## Outcome
276 tests green. Frozen-contract neutral. Ships as 0.4.0.
