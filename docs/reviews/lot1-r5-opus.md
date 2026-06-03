# Lot 1 — Round 5 (convergence / final freeze) — Opus 4.8

**Gate:** `npm run typecheck` clean; `npm test` = **49/49 green** (6 files).

## Central claim attacked: hash ≡ persist by construction (materialize-once)

Confirmed by code trace **and** empirically. In `store.appendCommand`: `materialize(core)` produces an inert deep clone; `contentHashOf(materialized)` hashes it; `event = {...materialized, frame}` is built from the snapshot. Everything downstream consumes the snapshot-derived `events`, never the live `input`/`core`/`payload`:
- `validate([...existing, ...events])` recomputes over the same `event` objects.
- `appendAtomic(events)` serializes the same `event` objects.
- `writeHead` only reads `events[last].contentHash`.

There is no path that re-reads the live input after materialization.

### Empirical falsification campaign (all probes failed to break it)

1. **Live read count is exactly once** — a `Proxy` payload logging every get produced one read per data key across the entire `appendCommand`; no second traversal by validate/persist/head.
2. **validate vs persist cannot disagree** — candidate-validate hash, on-disk recomputed hash, and stored hash all equal under a lying `Proxy`; read-back `validate.ok === true`. Confirmed for nested proxies, 3-event batch proxies, top-level getter on `by`.
3. **No accept-side hole** — `computeHash(snap) === computeHash(JSON.parse(JSON.stringify(snap)))` for nested arrays, integer-like keys, exotic unicode keys, `-0`, extreme finite numbers; `__proto__` round-trips as a data key with no prototype pollution (null-proto accumulator).
4. **No false-reject** of legitimate inert JSON.
5. **Reject side intact** — NaN/Infinity, Date/Map/class/boxed, object+array `toJSON`, accessors, sparse holes, BigInt/symbol/function members, proxy-with-toJSON-trap.

## Regression (rounds 1–4) — all hold.

## Findings

None at BLOCKER/MAJOR/MINOR. Two carried NITs (head empty-digest / `MAX_SAFE_INTEGER`; SPEC key-order note).

The materialize-once architecture closes the live-object divergence class by construction. I could not break it.

**VERDICT: FREEZE-OK**

---
_Round-5 note: Codex (parallel reviewer) found that the persisted `event` wrapper is `Object.prototype`-based (not inert), so under in-process `Object.prototype.toJSON` pollution `JSON.stringify` could diverge; and that the array branch uses `i in value` (catches inherited indices) rather than `Object.hasOwn`. Both are in-process-API-abuse vectors (unreachable from CLI/JSON input) but cheaply closed by persisting via `canonicalize` (same fn as the hash) + own-only/`hasOwn` checks — making hash≡persist true by identity. Applied; see lot1-r5-reconciliation.md._
