# Bulk resolve-by-engagementRef — Opus 4.8 review

Paired with `docs/reviews/lot-D-resolve-by-engagement-codex.md`. **Verdict: ship-with-changes** → applied.
The feature is correct, idempotent, atomic, and additive; the security property holds and is tested.

## Confirmed (ground-truth checked)
- **`resolveExternalDependency`:** the filter is the exact complement of the reader's watch predicate, so it
  resolves precisely the open extra deps the bridge sees — no more, no less. N=0 guarded. The
  **multi-aggregate cmdId batch is valid** (validate's batch rules are per-cmdId, aggregate-agnostic; N
  distinct blockers each get seq:1). Cross-engagement isolation tested.
- **Ingest containment:** a W-pinned signed channel resolving an engagement blocking {W,V} clears ONLY W
  (V untouched) — no bypass. **Binding gate** confirmed. **Additive / frozen** confirmed (new ingest-kind
  only; emits the existing `blocker.resolved`). **Idempotency/retry** safe (state filter + clientToken).
- **CLI:** local human unscoped (`'all-workspaces'`) is fine (the operator is the trust root).

## The footgun → FIXED (both reviewers, two layers)
Deferred containment moved from the central `authorize` gate to the method's call site, defaulting an
omitted pin to "resolve everything" — a silent cross-tenant resolution if a future caller dropped the arg.
**Fix:** (1, Opus — compile-time) `resolveExternalDependency`'s `scope` is now a **required** `ResolveScope`
(`{workspace}` | `'all-workspaces'`), so a TS caller cannot forget it and unscoped is an explicit opt-in;
(2, Codex — runtime) a guard rejects a scope object without a concrete workspace string, so a JS/`as any`
caller also fails closed. Tests: the W/V containment, the runtime-guard rejection, the cmdId-batch
atomicity (`shared cmdId`, `cmd.n===2`), and the unauthenticated-channel rejection.

## Outcome
313 tests green; frozen-contract neutral. Ships as 0.8.0 — completes the deferred M3 deps follow-up.
