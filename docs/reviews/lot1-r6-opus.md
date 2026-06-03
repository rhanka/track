# Lot 1 — Round 6 (final convergence) — Opus 4.8

**Gate:** `npm run typecheck` clean; `npm test` = **53/53 green** (6 files).

## The change under review: persist via `canonicalize(event)`

`canonicalize` is now the **only** serializer on both integrity paths:
- **Hash:** `contentHash = sha256(canonicalize(materialize(core)))`.
- **Persist:** each line = `canonicalize(event)`, `event = {...materialize(core), frame}`; `head.json` also via `canonicalize`.
- **Read-back:** `validate` = `sha256(canonicalize(stripFrame(JSON.parse(line))))`.

The only `JSON.stringify` on the authoritative path is inside `canonicalize` for leaf strings/numbers/keys. Remaining `JSON.stringify`/`JSON.parse` are non-authoritative (readAll parse of inert data; readHead shape-validated; snapshots — rebuildable caches).

## Verification

1. **Persist ≡ hash by identity — CONFIRMED.** `canonicalize(stripFrame(JSON.parse(canonicalize(event)))) === canonicalize(materialize(core))` verified over 12 cases; the canonical→parse→canonical **fixpoint** holds over 34 cases (number reformatting `1e21`/`1e-7`/`>MAX_SAFE`/`MIN_VALUE`/`-0`, unicode incl. lone surrogates and U+2028/29, quotes/emoji/`__proto__`/empty/int-like keys). No non-fixpoint found.
2. **Pollution immunity — CONFIRMED.** Under live `Object.prototype.toJSON`, `Array.prototype[0]`, inherited `Object.prototype` key, `Array.prototype.toJSON`: persist `line === canonicalize(event)` and read-back `validate.ok === true` in all cases. Own-only inspection makes hashing, array enumeration, and `toJSON` detection immune.
3. **Liveness — CONFIRMED.** Exactly one traversal of the live input (Proxy get logged → reads=1, validate.ok=true).
4. **Regression — INTACT.** contentHash domain, prevHash chain, per-aggregate seq, cmd:{i,n} batch, head anchor+shape, fold determinism, fail-closed validate-before-append.
5. **No false-reject** of legitimate inert JSON (`{"toJSON":"a string"}` correctly accepted — reject only `typeof toJSON === 'function'`).

## Findings

**NIT — doc** `SPEC.md:215` still said "persisted (`JSON.stringify`) form"; the store persists via `canonicalize`. (Fixed post-review.)

**Carried NIT (R5)** head empty-digest / `MAX_SAFE_INTEGER` — informational, not freeze-blocking.

The hash≡persist invariant is closed by identity (one serializer, one inert snapshot, own-only, single traversal). I could not break it.

**VERDICT: FREEZE-OK**
