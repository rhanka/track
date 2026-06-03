# Lot 3 Review — `@sentropic/track` (Opus 4.8)

**Build:** typecheck clean; `npm test` = 92/92 green. `git diff HEAD~1 HEAD -- src/events/` empty — frozen contract untouched. 15 extra probes run (disposition orderings, no-go-on-terminal, multi/shared/cross-gate targets), all green.

## Findings

1. **Gate disposition stream-order (§2.10) — CORRECT for all orderings** (explicit-then-settle→completed; settle-then-explicit→explicit; two settling same-gate→completed; deferred-then-go→completed only on go; cross-gate isolation holds; absence→default required). No defect.
2. **Outcome machine + atomic no-go batch (§2.6, A5) — SOUND; the skip-terminal choice is defensible.** `no-go` resolves the blocker for all targets but rejects only `to-do`/`in-progress` targets. Rejecting the whole command when a target is terminal is worse — it would strand the other targets AWAITED and (for a `done` target) make the decision un-settleable. Severity: **nit** — add a comment at the skip so a future reader doesn't "fix" it.
3. **A7 — blocker find by (kind, ref=decisionId, targetId, open) — CORRECT, no mismatch risk.** decisionId globally unique; `.find` resolves exactly the matching open blocker; idempotent if already resolved.
4. **A3 recursion guard + Lot-4 acceptance-on-decision — FOUNDATION SOUND.** decisions/items disjoint maps; createItem hard-rejects kind:decision; a Lot-4 accept command can reject decision ids via `state.decisions.has`.
5. **Specialized axes (§2.5) — CORRECT.** Decision carries realization (prep) + outcome only; prepared independent of settled; setRealization on a decision uses hasCause:false so it can never be manually rejected; setDisposition rejects decision ids.
6. **Correctness — none found.** emitBatch shared `at` + single cmdId when >1; candidate full-stream re-validation before write; partial-batch detection verified; exactOptionalPropertyTypes idiom correct; decisions structured-cloned in snapshot.
7. **Lot 2 foundation — sound.** assertRealizationTransition widened to `{id,realization}` serves both ItemState and DecisionState without weakening checks.

### Nits (non-blocking)
- comment why terminal targets are skipped in no-go (finding 2).
- `setRealization`/`requireItem` double-fold per command (perf, pre-existing Lot 2).
- `realization.transition` cause:{decisionId} emitted but not materialized onto ItemState (Lot 4/report concern; §2.3 only requires it be emitted).

**VERDICT: SHIP**
