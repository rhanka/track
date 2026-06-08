# Lot v2.3c IMPLEMENTATION (ingest idempotency) — Codex (gpt-5.5 xhigh) review

Lot-1-grade review of the `clientToken` idempotency implementation. Paired with
`docs/reviews/lot-v2.3c-impl-opus.md`. **Verdict: ship-with-changes** — sound for M2b; the changes were
test/doc coverage, not a blocking correctness fix. Codex independently ran `npm run lint` + `npm test`
(25 files / 276 tests pass).

## Confirmed sound
- **Additivity:** `EventCore.clientToken?` is optional; `materialize`/`canonicalize` drop `undefined`, so
  pre-v2.3c events hash byte-identically; `contentHashOf` hashes the core (token included) and `validate`
  recomputes from `stripFrame` ⇒ a tampered token is a `content-hash` finding (tested). No event-type /
  frame / fold change.
- **`withClientToken` scoping:** set/finally-restore; `emitBatch` stamps every event of the batch
  (`decision.create`'s `decision.created` + N `blocker.opened`); ingest wraps exactly `applyCommand`.
  (Caveat for a FUTURE async use: restore would precede awaited writes — current facade is synchronous.)
- **Skip + stable ids:** `resultIdOf` returns aggregateId for item/decision/blocker creates and the
  payload id for criterion/evidence; `decision.created` is the first tokened event so the returned id is
  the decisionId.
- **Cross-workspace collision FIXED in current code:** `tokenIndex` records only events whose folded
  event-workspace equals the channel workspace — a V token no longer suppresses W or returns V's id.
- **Intra-stream dup, untokened at-least-once, deferred concurrency/non-atomicity:** all sound /
  accurately stated. The append lock has no in-lock token recheck (parallel absent/absent race) — correctly
  deferred to M3.

## Changes applied (Codex's asks)
- Tests added: tokened `decision.create` multi-event batch wholesale skip (returns decisionId); tokened
  `decision.outcome no-go` batch skip; V/W same-token collision proving workspace scoping; stable-id
  coverage for `blocker.raise` + `acceptance.link`.
- Design doc updated: the implemented namespace is **per-workspace**, not global.
- (M3 note retained:) same-workspace cross-principal probing should be scoped by authenticated
  principal/request id when M3 lands.

## Outcome
276 tests green; lint + build clean. Ships as 0.4.0.
