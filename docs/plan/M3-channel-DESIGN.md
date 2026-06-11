# M3 — authenticated server-to-server write channel (HTTP + signed) — design + decision

**Date:** 2026-06-10 · **Status:** **DECIDED — defer the gateway build (option A); ship only the track-core
prerequisite now.** Design pair-converged (Codex 5.5xhigh + Opus 4.8max) and ready to build (option B) the
moment a network caller exists. Owner dossier presented; rhanka confirmed the situation (no network caller
yet — the h2a bridge + the sentropic conductor write via library-import/CLI; the conductor explicitly said
"pas besoin du bridge M3 signed pour l'instant").

## 0. Decision (present-decision dossier outcome)
- **A — DEFER the HTTP gateway** until a concrete network caller needs it (none today; HTTP is a "follow-on"
  in `sentropic-integration-TARGET.md`). Library-import (the shipped Lot B recipe) covers 100% of current
  writers.
- **Ship now (track-side, sane regardless):** close the deferred **concurrent-retry race** (`clientToken`
  recheck **under the lock** in `appendCommand`). This is the **only** track-core change M3 needs.
- **Escalate to B** if the sentropic architect's branch plan puts write-HTTP at the top, or any service that
  cannot import the library needs to write.

## 1. The two-layer auth resolution (the spine — both halves identical)
A network write endpoint MUST authenticate the CHANNEL; track NEVER verifies the ATTESTATION. Keep them
physically separate:
- **Layer 1 — TRANSPORT auth (the gateway enforces):** verify the caller before `ingest()` is reachable.
  Maps the verified identity → `IngestContext.by` = `prov.principal` (the layer-1-verified id, **never from
  the request body**) + `prov.auth:'signed'` (asserted on layer-1 strength) + `prov.transport:'http'` +
  `workspace`/`allowedKinds` from the capability bound to that identity.
- **Layer 2 — ATTESTATION (track records, never verifies):** `prov.sig` copied **opaque** (the caller's
  domain attestation, e.g. an NHI Ed25519 signature). Nobody verifies it in-band; it is audit ballast. `sig.by`
  (domain signer) MAY differ from `prov.principal` (channel writer) — that difference is audit signal, not a
  bug (a bridge `principal:svc:h2a-bridge` carrying an NHI's `sig.by`). **Invariant:** `by===principal===`
  layer-1-verified id; never derive `by`/`principal` from the payload or from `sig.by` (the confused-deputy D3
  killed).

## 2. The design (option B, when triggered) — pair-converged
- **Shape:** a **thin HTTP→`ingest()` gateway**, a **separate co-versioned package in the track monorepo**
  (e.g. `packages/track-ingest-http`), its own bin/dep; **NOT** in the pure `@sentropic/track` core, **NOT** in
  `track-mcp` (stays read-only, per D3). The library never imports the gateway; the gateway depends on track
  and is **contract-snapshot-tested against `ingest()`** so the security-critical `prov`-mapping stays inside
  track's quality gate. One route: `POST /v1/ingest` (body = `{events: WorkEvent[]}`; **no `by`/`prov`/
  capability in the body**) + `GET /v1/health`. Returns the AppendReceipt over the wire (`{receipts:[{id,
  contentHash,seq,aggregateId}], ids, applied/deduped}`) — "rc=0 without persistence is impossible" extends
  end-to-end.
- **Transport auth:** **Ed25519 / RFC-9421 HTTP Message Signatures** as the primary (works in- and out-of-mesh,
  NHI-native; covers `@method`/`@target-uri`/`content-digest`/`created`/`nonce`); **mTLS** as mesh-native
  defense-in-depth; **OIDC token-exchange** acceptable where the platform IdP fronts the caller (verify
  issuer/aud/exp/JWKS; never store the bearer in the log). Bare bearer tokens = dev-only. The gate lives in the
  gateway; track owns no keys/TLS/nonce-cache.
- **Capability:** server-side registry (or verified OIDC claims) keyed by the verified principal →
  `{workspace, allowedKinds, proposed}`. Deny-by-default. Reuses the **shipped** `authorize()` (allowedKinds +
  workspace containment) unchanged. Path workspace ⊆ capability; create-payload workspace must match.
- **Idempotency:** require an HTTP `Idempotency-Key` → mapped to per-event `clientToken` (principal+workspace+
  key+index); a durable idempotency record returns the same receipt for the same digest, `409` on a different
  body with the same key. Relies on the **prerequisite** (the under-lock recheck) for concurrent safety.
- **Journal authority (D4):** CONFIRMED unchanged — track frames canonical for product state + ordering; h2a
  canonical for negotiation/signature envelope. Cross-journal reconciliation (outbox/saga) = a D4-followup,
  not a blocker.
- **Deployment:** **single-writer, gateway+`.track` co-located** (RWO PVC / sidecar) — the file lock is
  same-host only; a multi-replica gateway over a shared FS recreates corruption. Horizontal scale =
  **workspace-sharding** (one log per workspace); true multi-writer-on-one-stream = **M4** (a new
  frozen-contract round, out of scope). TLS at ingress; per-principal rate-limit (an authenticated flood
  serializes on the lock); structured audit of accepted + rejected writes.

## 3. Threat model (both halves)
rogue writer → 401 at the gateway before `ingest()`. replay → nonce+created+digest window (+ `clientToken`
idempotency as defense-in-depth). confused deputy → `by`/`prov` never from the body; service-on-behalf-of-human
requires explicit verified delegation else it's a service write. cross-workspace → gateway pins workspace +
ingest re-checks folded state. compromised gateway → blast radius bounded to its capabilities; cannot rewrite
history (immutable log + AppendReceipt); **mitigation = small code + official conformance tests** (both halves'
#1 residual risk: a gateway that mints `prov.auth:'signed'` wrongly and track faithfully preserves the lie).

## 4. Net delta to shipped track core
**One additive change (the prerequisite, shipping now):** the `clientToken` recheck inside `appendCommand`
under the held lock (closes the M3-deferred concurrent-retry race). Optionally: publish the ingest contract as
a consumable JSON-Schema/`.d.ts` (the WorkEvent v0 freeze artifact — coupled to the sentropic seam freeze).
**Everything else is the separate gateway**, built on demand. `ingest()`, `IngestContext`, `BINDING_AUTH`,
`prov`/`auth:'signed'`/`transport:'http'`, containment, per-workspace `tokenIndex`, AppendReceipt — all
already shipped and unchanged.
