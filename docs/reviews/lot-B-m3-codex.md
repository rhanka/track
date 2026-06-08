# Lot B (M3 signed write channel, shape A) — Codex (gpt-5.5 xhigh) review

Lot-1-grade review, paired with `docs/reviews/lot-B-m3-opus.md`. **Verdict: ship** — "no blocking findings;
single most important fix: none required." Verified empirically (`npm run lint` + `npm test src/m3-signed.test.ts` pass, 7 tests).

## Confirmed sound (all 7 dimensions)
1. **Additivity / frozen contract:** `Provenance` only widens the optional `EventCore.prov` with additive
   enum values (`auth:'signed'`, `transport:'http'`) + optional `principal?`/`sig?`. `canonicalize` drops
   `undefined`; no new event type; frame/hash mechanics unchanged ⇒ old events hash byte-identically.
2. **Nested-sig snapshot:** `structuredClone(opts.prov)` fully detaches the nested `sig`; Node ≥20 (engine
   pin); a function/symbol prov fails before write (structuredClone throws, and store materialization
   rejects non-plain values). The mutation-after-construction test is load-bearing.
3. **Canonicalize/hash of nested sig:** the plain `sig` recurses through `materialize` + canonical key
   sort; `contentHashOf(stripFrame)` covers `prov.sig`; the tampered-sig test now pins detection.
4. **Binding + containment:** `signed` is admitted ONLY by the binding-auth allowlist; workspace
   containment runs independently before the binding gate (signed is not a bypass) — regression-tested.
5. **Semantics honesty:** docs explicitly state recorded-not-verified, not an EventCore signature, not a
   bearer token. Residual is contractual (track cannot prevent a caller stuffing a secret into `sig.value`;
   the doc says not to) — the correct boundary for a record-only system.
6. **Scope / CLI:** CLI stays `local-user`; file ingest stays `import`/`local-user`; signed contexts are
   built programmatically by the verified caller. `package.json` adds NO runtime dep (still
   `@modelcontextprotocol/sdk` + `ulid`). No network service / jose / verification leaked in.
7. **Tests:** 7 tests incl. the high-value tampered-sig + mixed-log cases. The only optional extra (tokened
   signed ingest) is auth-independent (idempotency is centralized) — not needed.

## Outcome
304 tests green; lint + build clean. Ships as 0.6.0.
