# Lot C (h2a-bridge read surface) — Codex (gpt-5.5 xhigh) review

Final lot of `M3-deps-raci-DESIGN.md`. Paired with `docs/reviews/lot-C-bridge-opus.md`. **Verdict:
ship-with-changes** → applied. Verified: 5 files / 69 focused tests pass.

## Confirmed sound
- **`externalDependencies()`** correct on valid logs: `b.open` is right for an extra/manual blocker
  (resolved events force closed; manual/no-ref stays open until resolved); filter excludes resolved-extra,
  intra, and decision blockers; baseline-free by design.
- **Read-contract additivity:** version 1.0.0→1.1.0 matches the additive-only policy; `ExternalDependency`
  `{blockerId, targetId, engagementRef, openedAt}` is minimal + load-bearing.
- **MCP tool:** `track_external_deps` is in `READ_TOOLS`, dispatch serializes `reader.externalDependencies()`,
  handler returns text only — no read-only-contract break.
- **Bridge pattern:** resolve-by-`blockerId` is "sufficient and cleaner for now"; `externalDependencies()`
  returns both `engagementRef` and `blockerId`, so one engagement blocking N items ⇒ resolve each returned
  blockerId. A bulk resolve-by-`engagementRef` is a write-path feature with cross-workspace/atomicity/
  idempotency questions — NOT needed for Lot C.
- **Plan completion:** coherent after the doc fix; no resolve-by-engagementRef required; `responsible` not in
  the report is not a Lot C blocker (the plan promised report surfacing of `accountable` only).

## Changes applied (both reviewers' asks)
1. **Design-doc wording fixed:** the bridge finds blockerIds via `externalDependencies()` keyed on
   `engagementRef`, then resolves each by `blockerId`; the `blocker.resolve` WorkEvent is `{blockerId}` only.
2. **MCP dispatch test added:** `dispatchReadTool(reader,'track_external_deps',{})` equals
   `reader.externalDependencies()`, and is side-effect-free (no append).
3. (Opus, complementary) the emitted `blocker.resolved` **event** now records `engagementRef` (server-side,
   additive) for audit — so a resolution ties back to its engagement without re-folding. + cross-workspace
   containment-on-signed-resolve test + the N-items-one-engagement fan-out test.

## Outcome
309 tests green; lint + build clean. Ships as 0.7.0 — completes the M3-deps-raci plan.
