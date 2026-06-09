# Bulk resolve-by-engagementRef — Codex (gpt-5.5 xhigh) review

Reviews `track.resolveExternalDependency` + the `blocker.resolve-external` WorkEvent kind (the deferred M3
follow-up). Paired with `docs/reviews/lot-D-resolve-by-engagement-opus.md`. **Verdict: ship-with-changes**
→ applied. Verified: focused suite + lint pass.

## Confirmed sound
- **Correctness:** the filter is exactly open + dependency + `scope:'extra'` + matching `engagementRef`, with
  optional workspace restriction by target-item workspace. Emits ONE command via `emitBatch` (one `cmdId`
  for N>1); a **multi-aggregate cmdId batch is valid** (validate checks completeness/contiguity/positions
  per cmdId, not same-aggregate; per-aggregate seq is independent). N=0 is guarded (no empty append).
- **Ingest containment:** `authorize` skips the single-workspace gate for this kind by design; dispatch
  passes `{workspace: ctx.workspace}`; W/V test confirms only W clears, V stays open.
- **Binding gate:** `settles:'always'` ⇒ auth ∈ {local-user, signed}; unauth rejected (tested).
- **Additivity:** a WorkEvent kind only; no new event type (`blocker.resolved` exists); seq/prevHash/hash
  framing unchanged; snapshot updated.
- **CLI:** local human passes `'all-workspaces'` explicitly — correct for a trust-root operation.
- **Idempotency:** retry sees no open matching blockers → `[]`; `clientToken` dedup is orthogonal +
  compatible (per-workspace skip; token stamped on every emitted resolve).

## Change applied (Codex's must-fix)
- **Runtime fail-closed guard:** `resolveExternalDependency` now REJECTS a scope object without a concrete
  non-empty `workspace` string — so even a JS / `{} as any` / `{workspace:undefined}` caller throws rather
  than resolving all workspaces; the literal `'all-workspaces'` is the ONLY unscoped path at runtime
  (belt-and-suspenders over the required `ResolveScope` type). Test added (direct facade call with `{}` /
  `{workspace:undefined}` throws).

## Outcome
313 tests green; lint + build clean. Ships as 0.8.0.
