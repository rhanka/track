# Lot 1 — FROZEN (event contract)

**Status: FROZEN at 53/53 green after 6 adversarial double-review rounds (Codex gpt-5.5 xhigh + Opus 4.8 each round).**

Round 6 reached convergence: Opus **FREEZE-OK**; Codex found *no implementation break* ("Hash path … persist path `canonicalize(event)` … readback … fixpoint … liveness one materialization … regression intact") and rated its sole finding — a stale SPEC `JSON.stringify` parenthetical — MINOR, "contract/docs only; no runtime input-surface exploit". That doc line is fixed. The implementation is unanimously sound.

## The frozen contract

- **Event frame** (SPEC §3): `{ id, type, aggregate, aggregateId, seq, prevHash, cmdId?, cmd?{i,n}, at, by, payload, contentHash }`.
- **contentHash domain** = the event *core* (everything except `{seq, prevHash, contentHash}`), faithful to h2a `stripFrame`.
- **Positional chain**: `prevHash` = previous stream event's `contentHash` (null for the first).
- **Per-aggregate `seq`**: 1-based, strictly contiguous.
- **Atomic batch**: `cmdId` + self-describing `cmd:{i,n}`, single `fsync`'d append, validate-before-append (fail-closed).
- **Head anchor** (`.track/head.json`, non-authoritative): suffix-truncation detection; shape-validated; degrades to null.
- **`fold` mechanism**: stream order + per-aggregate seq, deterministic, validated-stream precondition. (State *shape* grows in later lots; the *mechanism* is frozen.)
- **Canonicalization invariant (closed by identity):** the store `materialize`s each event to one inert plain-data snapshot in a single traversal, then computes `contentHash` **and** persists each line with the **same `canonicalize` serializer** over that snapshot. Own-property-only inspection makes it immune to `Object.prototype`/`Array.prototype` pollution and to live values (`Proxy`/getter). Hash domain ≡ persisted domain by identity, not by sampling.

## Frozen threat model (SPEC §3)

`validate` detects: content/field tamper, reorder, insertion, mid-stream deletion, partial batch, aggregate-type mismatch, and (with the head) suffix truncation. It does **not** detect from the log array alone: suffix truncation without the head, a full rewrite that re-chains every event, or SHA-256 collisions — delegated to the docs-git layer (single-writer MVP).

## Review trail

`docs/reviews/lot1-r{1..6}-{codex,opus}.md` + `lot1-r{1..5}-reconciliation.md`. Each round's findings were real and fixed: r1 hash-domain + truncation reframe; r2 `__proto__` bypass + candidate validation + head atomicity; r3 sparse arrays + accessors + head shape; r4 array-branch consistency + Proxy → materialize-once; r5 prototype-pollution → persist-via-canonicalize (identity); r6 convergence.

**Do not reopen the event/contentHash/chain/batch contract without a matching review round.** Lots 2+ add reducers and event-type semantics on top; they must not change the frame, the hash domain, or the canonicalization.
