# Lot 1 — review round 4 reconciliation (Codex gpt-5.5 xhigh + Opus 4.8)

Round 4 **split again**: Opus 4.8 ran a ~45-vector falsification campaign and returned **FREEZE-OK** (0 falsifications, 0 end-to-end bricks); Codex gpt-5.5 returned **CHANGES-REQUIRED** with two new BLOCKERs that Opus's vector set didn't cover.

## Independent adjudication — both valid, same root cause

1. **Array branch did not mirror the object branch's `toJSON`/accessor rejection.** An array with a `toJSON` method, or an accessor at an index, hashes one value and persists another. Verified — a real consistency gap.
2. **`Proxy` objects are undetectable and diverge across traversals.** A proxy over a plain object with plain descriptors passes every "is it plain?" check, yet a non-idempotent `get` trap returns different values when `canonicalize` reads it (hash) and again when `JSON.stringify` reads it (persist). Verified.

Both share one root cause: **the store hashed one traversal of a live object and persisted another.** Enumerating exotic shapes to reject (rounds 1–3) is whack-a-mole; proxies can't even be detected.

## Resolution — close the class by construction (materialize-once)

Adopted Codex's recommended architecture: `canonical.ts` now exposes **`materialize(value)`**, a single-pass deep clone to an inert plain-data snapshot that fail-loud rejects everything `JSON.stringify` would serialize differently than it hashes (non-finite, non-plain object, `toJSON`, accessor, sparse hole, `undefined`/symbol/function member) — for **both** arrays and objects. `store.appendCommand` materializes each event's core **once**, then hashes **and** persists that same snapshot. A live payload (Proxy / getter) is frozen to whatever the single traversal read, so hash ≡ persist **by construction** — the divergence class is empty, not merely sampled.

Gate green at **49/49**. New tests: `materialize` rejects array-`toJSON` and array-accessor; a live `Proxy` payload (incrementing `get` trap) round-trips through the real store with `validate.ok === true` (this test fails without the fix).

The array branch of `canonicalize` also gained the `toJSON`/accessor checks (defense for any direct `computeHash` call), so both the materialize gate and the canonicalizer reject these.

## Status

The two prior-round hash-domain defects AND this round's live-object class are now closed; the canonicalization invariant is closed by construction. Opus FREEZE-OK; Codex's blockers addressed by an architectural change (not a patch). → Round-5 convergence confirmation requested before freezing.
