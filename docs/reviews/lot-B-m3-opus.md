# Lot B (M3 signed write channel, shape A) — Opus 4.8 review

Adversarial Lot-1-grade review, paired with `docs/reviews/lot-B-m3-codex.md`. **Verdict: SHIP.** All
ground-truth claims verified empirically.

## Confirmed (with empirical checks)
1. **Additivity — byte-true.** `auth:'signed'`/`transport:'http'` widen existing unions; `principal?`/`sig?`
   are new optionals on `Provenance` (an optional `EventCore` field). A `prov` without `principal`/`sig`
   hashes identically to the pre-M3 shape (canonicalize drops undefined — checked, returns true). No new
   event type, no frame change.
2. **Nested-sig snapshot — PASS, load-bearing.** `structuredClone(opts.prov)` deep-detaches `sig`; mutating
   `opts.prov.sig.value` after construction does not leak into the clone (verified across a 2-event
   `createDecision` batch). A shallow spread would reopen the depth-extended D3 mutation hole. structuredClone
   throws loud on functions/symbol values; a symbol-keyed prop is silently dropped but is also invisible to
   `canonicalize` (Object.keys), so hash and persist still agree.
3. **Hash of nested sig — PASS.** `materialize`/`canonicalString` recurse into the plain `sig`;
   `contentHashOf` covers `prov.sig`; a one-char tamper changes the content hash ⇒ a `content-hash` finding.
   The recorded attestation is itself integrity-protected.
4. **Binding-via-signed + containment — PASS.** `BINDING_AUTH` admits `signed` for the trust gate only;
   workspace containment runs unconditionally and is independent of `auth` — no path where `signed` weakens
   a guard (`proposed`/`principal`/`sig` are never read by `authorize`; only `prov.auth` as a set membership).
5. **'signed' honesty — PASS.** The doc is honest and sufficient (records-not-verifies; sig is the channel's
   attestation, not a signature over the EventCore, not a bearer token). Residual is the correct
   record-only boundary (a doc contract, not a mechanical guard).
6. **Scope / CLI — PASS, no creep.** CLI unchanged; `package.json` adds no dep; grep for
   jose/forge/crypto.verify/createServer/express/fastify is clean — no network, no verification, no h2a leak.

## Follow-ups applied (Opus's non-blocking asks)
- **Tampered-`sig` ⇒ `content-hash` finding** test (mechanically pins that the nested `sig` is in the
  validated hash domain — the core value proposition).
- **Mixed old+signed log validity** test (no-prov + local-user + signed events validate together —
  additivity at the stream level).

## Outcome
304 tests green; frozen-contract neutral; zero scope creep. Ships as 0.6.0.
