# Round-2 Adversarial Freeze Review — Lot 1 of `@sentropic/track`

**Verification:** `npm run typecheck` clean; `npm test` = **38/38 green** (6 files). All eight accepted round-1 fixes landed and are individually correct except for a residual hole in the canonicalization hardening (below). SPEC §3/§4 and PLAN Lot 1 now match the code. The reframed BLOCKER is correctly reasoned.

## Accepted-fix verification

1. **Canonicalization hardening** (`canonical.ts`) — prototype check correctly rejects `Date`/`Map`/class/typed-array/`Object.create(customProto)` and accepts null-proto + literal plain objects. **But it does not close the hash≠persist divergence class it was created to close** — see MAJOR-1.
2. **Batch validation** (`validate.ts`) — robust. Fuzzed missing/fractional/negative `n`, missing/negative/duplicate/out-of-range `i`, non-contiguity, count mismatch, `cmdId`-without-`cmd`: every case yields a finding and `ok:false`. No bypass.
3. **Atomic append** (`store.ts`) — `writeSync` correctly looped with right offset math + `fsyncSync`.
4. **Validate-before-append / fold precondition** — a tampered or head-detected-truncated log is refused. No append path skips validation.
5. **Head anchor** — detects suffix truncation; stale head tolerated; head-position tamper caught; append-log-then-write-head is the right order. **One new corruption mode introduced** — see MAJOR-2.
6. **aggregate-mismatch**, **serializeState deep-copy**, **SPEC-drift**, **threat model frozen** — all landed and correct.

## Findings

**[MAJOR-1] Canonicalization still leaves a hash≠persist divergence — an integrity (A4) bypass, not just a self-validate failure.** The prototype check only covers non-plain *objects*. On a *plain* object:
- **`__proto__` literal key (JSON-reachable):** a payload `{"title":"x","__proto__":{"evil":1}}` parsed from JSON has prototype `Object.prototype` (no rejection). `Object.keys` lists `__proto__`, but `out["__proto__"]=…` sets the prototype instead of an own key, so the value **silently vanishes from the hash domain** while `JSON.stringify` persists it. Verified end-to-end: the line is written with `__proto__` on disk, `validate` returns `ok:true`, and editing the on-disk `"evil":1`→`"evil":999` is still `ok:true` — undetected content tamper.
- **non-enumerable `toJSON` (programmatic):** hashes via `Object.keys` (skips it) but persists via `toJSON` — divergent.

The `__proto__` vector is the serious one (reachable from arbitrary JSON payload input). *Fix before freeze:* canonicalize from the same domain you persist — null-proto accumulator / `Object.defineProperty`, reject `__proto__`/`constructor`/`prototype`, or hash the JSON-roundtripped value. This is the only finding I consider freeze-blocking.

**[MAJOR-2] Torn/corrupt `head.json` bricks all future appends — a new corruption mode the head anchor introduced.** `readHead` does a bare `JSON.parse` with no guard; `writeHead` uses non-atomic `writeFileSync`. A crash mid-write leaves a torn `head.json`; `appendCommand` calls `readHead` unconditionally → every subsequent append fails. Since the head is non-authoritative/rebuildable, a parse failure must degrade to `null`, never throw. *Fix:* try/catch in `readHead` → `null`; write the head atomically (temp + rename).

**[MINOR-1] SPEC §3 flow diagram label is stale.** `SPEC.md:72` reads `validate: payload-hash + prevHash + seq`; the frozen domain is the event *core*. Update to `core-hash`.

**[MINOR-2] Post-truncation fail-closed has no recovery in Lot 1.** Documented deferred posture (tolerant repair = post-MVP); acceptable to defer if acknowledged.

**[NIT-1] `validateHead` only checks the anchor at `head.streamLength-1`.** A full rewrite-with-rechain that also rewrites the head is undetected — exactly the frozen threat model, delegated to docs-git. Correct as scoped.

## On the reframed BLOCKER (global `streamSeq`)

**I agree with the author.** A global per-event counter does not detect suffix truncation: dropping the trailing K entries leaves `sequence 0..n-K-1` contiguous. h2a's `verifyJournalChain` has exactly this limitation. Track is therefore not "strictly weaker than h2a"; with the head anchor it is stronger. No global `streamSeq` is required before freeze.

## Net

The integrity *architecture* is now sound and the truncation gap is properly closed. The two MAJORs are both in the canonicalization/head plumbing the round-1 fixes touched; both are cheap to fix and touch frozen/hot-path code, so they should land before freeze.

**VERDICT: CHANGES-REQUIRED**
