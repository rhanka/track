# Lot 2 Review — `@sentropic/track` (Opus 4.8)

**Gate:** typecheck clean; `npm test` → 71/71 green. `git diff HEAD~1 HEAD -- src/events/` empty — frozen Lot 1 contract untouched.

## SPEC conformance — verified

- Spec axis (§2.2): monotone `to-specify→specified`, reverse rejected, `n/a` for decisions. Correct.
- Realization (§2.3): `to-do→{in-progress,cancelled}`, `in-progress→{done,cancelled}`, terminals; `rejected` only with a cause from to-do/in-progress. Matches §2.3/§2.6.
- Blocker (§2.9): open set derived by fold; decision blocker manual-resolve rejected; linked-done auto-resolves when ref done; only manual dependency allows resolve. Conforms.

## Fold evolution — mechanism intact

Single in-stream-order pass; only the shape grew (generic → typed `{items,blockers}`). Derived open-ness is deterministic (finalized after replay; pure function of final item map). Edge cases handled: ref not yet seen → open; resolvedByEvent short-circuits; `done` terminal so no flap.

## Command-facade design — supports Lot 3

fold→guard→append is sound; the realization rejected+cause guard and decision-blocker resolve rule are exactly what a no-go outcome needs. Foundation observation: `emit` is single-event only; Lot 3 needs an additive `emitBatch`/`cmdId` (the store primitive already supports it) — no rework.

## Findings

- **minor** `track.ts` `resolveBlocker` has no "already resolved" guard → double-resolve emits a redundant `blocker.resolved`. Fix: reject if `!blocker.open`.
- **minor/debt** A `linked-done` dependency whose ref ends `cancelled`/`rejected` stays open forever (target permanently AWAITED). Spec-conformant as written, but latent debt — clarify before Lot 5 `report`.
- **nit** `State.blockers` is `Map<string,…>` while `items` is `Map<ItemId,…>` — use `Map<BlockerId,…>` for parity.
- **nit** `createItem` spreads possibly-`undefined` optional keys; harmless (materialize drops undefined).

## Debt for Lots 3–7
1. Lot 3 adds a batch emitter (`cmdId`).
2. SPEC §2.9 cancelled/rejected-ref ambiguity under linked-done.
3. resolveBlocker double-resolve guard.

Deliverables complete, spec-conformant, frozen contract untouched, gate green. Findings are minor/nit/debt.

**VERDICT: SHIP**
