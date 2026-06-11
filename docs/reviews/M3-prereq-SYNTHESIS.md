# M3-prereq review SYNTHESIS — conductor adjudication of a divergent pair

**Date:** 2026-06-10 · **Reviewers:** Codex 5.5xhigh = **BLOCK** (4 MUST-FIX); Opus 4.8max = **SHIP** (2
SHOULD-FIX). **Adjudication: side with the stricter verdict on the genuine bugs, but locate two findings at the
correct layer.** Decision is reversible (pre-release) → taken + traced per working-loop hygiene.

## The divergence
The pair split on severity because each anchored a different altitude:
- **Opus** judged in-production: no channel injects `newId`, the only synthetic id embeds its workspace ⇒
  containment holds, P0 holds, contract frozen ⇒ SHIP.
- **Codex** judged by-construction: `aggregateId` is an unconstrained string, `newId` is injectable, `validate`
  enforces no workspace/global uniqueness ⇒ the `(clientToken, aggregateId)` scope is **not** provably
  equivalent to the per-workspace `tokenIndex` ⇒ BLOCK until correct by construction.

## The point BOTH missed (the adjudication hinge)
A retry **re-mints fresh `id` and `at`** per attempt (ULID + timestamp minted inside ingest AFTER the WorkEvent
is received). Therefore the persisted event's `contentHash` **legitimately differs** between the first write and
its concurrent-retry — even though it is the "same" logical delivery. Consequences:
1. **Codex finding 2 (compare body / 409) canNOT be enforced at the store layer** — comparing `contentHash`
   there would REJECT the very legitimate race this fix exists to absorb. The "body" that must be stable for a
   409 is the WorkEvent payload, which lives at the **ingest/gateway** layer (pre-mint), not the store.
2. **Codex finding 1 (workspace-equivalence)** is likewise an ingest-layer property: the store is
   **workspace-blind by design**; workspace containment is THE load-bearing property enforced in `ingest`
   (containment check), above the store. The store dedup is a race backstop scoped to `(clientToken,
   aggregateId)` and depends on ingest containment + ULID uniqueness — which it must DOCUMENT, not re-implement.

So findings 1 & 2, taken literally as "fix in the store," are architecturally misplaced — but Codex's BLOCK
instinct is right that the current store code has **two real bugs** (findings 3 & 4).

## Resolution (the fix shipped)
**Store-layer fixes (real bugs):**
- **F3 — validate-before-dedup:** run `validate(existing, readHead())` BEFORE the dedup short-circuit, so a
  duplicate can never return rc=0 (success) on a corrupt/tampered/truncated log. Fail-closed on every success
  path. (`store.ts` reorder.)
- **F4 — exact-set-match + faithful return:** the dedup fires ONLY when the persisted token-events' aggregate
  set EQUALS the command's input aggregate set; it returns EXACTLY those events (contiguous, ordered). Because
  `appendAtomic` is all-or-nothing, a true retry of one batch always satisfies set-equality. If a delivery
  token is found spanning a DIFFERENT aggregate set (superset/partial) → **throw fail-closed** (a producer
  reused a delivery token across logically distinct commands — a contract violation, never a silent superset
  return or a cross-workspace disclosure).

**Layer-located findings (documented, not store code):**
- **F2 (body-digest / 409):** documented at the store that the dedup deliberately does NOT compare bodies
  (post-mint `id`/`at` vary across retries; `clientToken` is the only stable key). Body-digest conflict
  detection ("409 on same key, different body") is the **gateway/ingest** contract → filed as a tracked
  **M3-HTTP** deferred item; the gateway MUST be built WITH it, never on a body-blind assumption.
- **F1 (workspace-equivalence):** documented that the store is workspace-blind; containment is the ingest
  layer's load-bearing property. The store dedup's `(clientToken, aggregateId)` scope assumes per-workspace
  aggregateId uniqueness (ULID minting + ingest containment) and fails closed (F4 throw) on any token/aggregate
  anomaly rather than silently suppressing.

**F5 (partial match)** — subsumed by F4 (atomic append ⇒ no real partial; token-spanning-sets ⇒ throw).
**F6 (frozen contract)** — confirmed clean by both; the only behavioral change (success-before-validate) is
exactly F3, now fixed.

## After the fix
Update the tests that blessed body-blind dedup (a same-token/different-aggregate-set case must now throw, not
return a superset; a same-token/same-set retry still dedups). Re-run full suite + typecheck + build. Then a
FOCUSED pair re-review of the patched `dedupByClientToken` + the reorder to confirm convergence, then ship
(no co-author) + bump + CHANGELOG + tag→OIDC. File the M3-HTTP "409-on-divergent-body" deferred item.

## Round 2 — convergence re-review + a SECOND divergence (owner-steered)
The focused re-review converged on F1–F4 (Codex: all RESOLVED/RELOCATED-OK; Opus: SHIP) but **diverged again** on
end-to-end concurrent-retry completeness:
- **Codex = BLOCK**, two residual MUST-FIX: (1) a concurrent `item.create`/`decision.create` retry re-mints a
  fresh aggregateId per attempt → the store dedup (keyed `(clientToken, aggregateId)`) sees a different
  aggregate → Case A appends → **double-create**; (2) when the store dedup DOES fire for a stable aggregate
  whose facade re-mints a result id in the payload (`linkEvidence`→`evidenceId`), `emitBatch` **discards** the
  returned originals and `ingest()` returns a **freshly-minted, never-persisted id**.
- **Opus = SHIP**, classing both as a documented "caveat" (create-retry deferred to M3 request-level
  idempotency; the store backstop scopes to stable-aggregate transitions).

**Premise change surfaced to the owner.** This falsified the dossier's "small, sane-regardless prerequisite"
premise: done *correctly* end-to-end this is a **seam refactor**, and the concurrent path it hardens is only
exercised by the **deferred** M3-HTTP gateway (today's single-process writers are already covered by the
pre-lock `tokenIndex` fast-path). Presented options A (fix #2, defer #1) / **B (full seam now)** / D (defer all,
keep the captured design) with préco B (the only option where the strict reviewer lifts BLOCK; integrity is a
system-of-record's core value).

**Owner decision: B — full seam now.**

### The seam (built)
Idempotency keyed `(workspace, clientToken)`, checked-and-committed **atomically under the store lock**, with
the store staying workspace-blind:
- `appendCommand` gains an injectable `dedupe(inputs, existing)` hook, invoked under the lock AFTER the F3
  integrity validate, BEFORE framing. Default = the existing `dedupByClientToken` (for direct store callers).
- Ingest supplies a **workspace-scoped** hook: scan `existing` for events where
  `eventWorkspace(e) === workspace && e.clientToken === token` (reusing the same `eventWorkspace` the
  `tokenIndex` uses). Within a workspace a `clientToken` identifies exactly one logical WorkEvent, so the key is
  **independent of the re-minted aggregateId** → closes #1 (create-retry). Workspace is IN the key → cross-
  workspace namespacing preserved by construction. `appendAtomic` atomicity ⇒ `(workspace, token)` is present
  as the whole original command or absent (no partial/superset).
- `emitBatch` returns the persisted events; `ingest()` derives result ids from the **persisted** events (single
  source of truth) → a deduped concurrent retry returns the ORIGINAL ids (create → original aggregateId;
  linkEvidence → original evidenceId) → closes #2.

Then a THIRD focused pair pass to confirm both reviewers reach SHIP, then ship. The M3-HTTP "409-on-divergent-
body" gateway item still stands (body-digest conflict detection remains the pre-mint gateway's contract).
