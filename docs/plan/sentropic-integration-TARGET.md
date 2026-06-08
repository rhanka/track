# Integration target — `@sentropic/track` inside `sentropic.sent-tech.ca`

Status: **living target** (grounds the v2 milestones). Factual sections are verified against the
sentropic ecosystem (sibling repos `../sentropic`, `../a2a-cli/packages/h2a`,
`../sent-tech-design-system`). M2b-specific posture decisions are marked *pending double-review*.

## 1. What `sentropic.sent-tech.ca` is (verified)
A **live Kubernetes SaaS** (Kapsule/`poc-k8s`, Traefik Ingress `sentropic.sent-tech.ca`, cert-manager
+ Cloudflare DNS-01):
- **UI**: SvelteKit 5 (adapter-static, Vite/TS), served behind nginx that proxies `/api`.
- **API**: Hono on `@hono/node-server`; **Postgres** via Drizzle; S3/Google-Drive connectors.
- **Auth/identity**: WebAuthn **passkeys** + a built-in **OAuth2/OIDC IdP**
  (`@sentropic/auth-{client,hono,ui}`): Ed25519/EdDSA JWT, JWKS rotation, PKCE S256, optional DPoP.
  Server session shape: `AuthUser { userId, sessionId, role, workspaceId, email, displayName }`.
  **Everything is workspace-scoped; roles are per workspace** (RP id = `sent-tech.ca`).
- **MCP consumption**: the platform's `McpCatalogSource`
  (`api/src/services/catalog/sources/mcp-source.ts`) connects to MCP servers over **stdio _or_
  HTTP/SSE** (pluggable `transportFactory`), discovers via `tools/list`, dispatches via `callTool()`.
  MCP sources are **opt-in / default-off** (0-regression).
- **Agent identity (cross-repo)**: `@sentropic/h2a` provides **NHI** (Ed25519-signed named
  human/agent identities, e.g. `claude:track:238a…`), an append-only journal, blockage raise/resolve,
  and negotiation (go/no-go) with signatures.
- **Design system**: `@sentropic/design-system-svelte` (published) is the consumable Svelte DS for any
  track UI surface.

Track is **not yet wired** into the platform; it is a federated cross-repo package (`@sentropic/track`,
`rhanka/track`). The seam is being designed now.

## 2. Identity mapping (the load-bearing constraint)
A track actor (`by: ActorId`) and the D3 `prov` trust level must map cleanly onto **who sentropic says
is acting**:

| Caller of a track write | track `by` | `prov.auth` | Notes |
|---|---|---|---|
| Local human at the CLI | `human:<git-email \| $USER>` | `local-user` | shipped (0.2.0) |
| CI / acceptance ingest | evidence-scoped | n/a (read→`accept run`) | shipped (v2.1) |
| Platform end-user (passkey/OIDC) via host→MCP | `human:<userId@sent-tech>` *(proposed)* | *pending* — `unauthenticated` (track did not verify) vs a new host-delegated value vs M3 `signed` | **decision under double-review** |
| Cross-repo agent (h2a NHI) | the NHI id | `signed` (M3, h2a Ed25519) | M3/h2a |

**Trust boundary (the crux):** track-mcp over stdio **cannot verify a passkey/JWT** — the *host*
(sentropic) authenticated the user. Track must be explicit about what it does **not** promise
(it attests transport + caller-asserted actor, not end-user authentication) until h2a signatures
(M3) make the actor cryptographically verifiable. This is the heart of the M2b posture decision.

## 3. Transport reality
- **Today**: `track-mcp` is **stdio-only** → reachable as a **subprocess** with a working dir
  (`.track/events.jsonl`). Fine for the `stp` CLI federation and local/agentic use.
- **For the deployed k8s platform to reach track remotely**: an **HTTP / streamable-http** transport
  is required (the SDK supports it; `McpCatalogSource` already speaks HTTP/SSE). This is a **follow-on
  lot**, not M2b core, but the M2b server seam must not preclude it (keep transport in the thin
  adapter, command layer transport-agnostic).

## 4. Write paths — two candidate seams (decision pending)
1. **MCP write tools** (PLAN-v2 M2b): write tools 1:1 over existing commands, gated by D3
   actor/capability, for **interactive/agentic** writes (platform chat/flow runtime, `stp track`).
2. **Neutral-event ingest adapter** (sentropic ecosystem draft): a harness emits neutral `WorkEvent`
   JSON → a **track-owned** adapter maps them to Items/Decisions; **harness never imports track**;
   MCP stays read-only. Best fit for **CI / harness / batch** provenance.

These are **not mutually exclusive**; the open question (under double-review) is *which is M2b* and
whether BOTH are eventually warranted (MCP writes for interactive, ingest adapter for batch). The
minimal M2b must not foreclose either.

## 5. UI surface (M5, later)
SvelteKit screens on `@sentropic/design-system-svelte` for `report` + decision **dossiers**, embeddable
in sentropic under a **shared embeddable-view contract** (defined once on the DS, consumed by
track/h2a/graphify/sentropic). Reads go through `@sentropic/track/read` (`TrackReader`) or the read
MCP tools — already shipped and parity-tested.

## 6. Milestone target, re-stated against this integration
- **M2a (done)** — read contract + read-only MCP + idempotent CI ingest. The platform/agents can
  already **read** track (parity-tested). ✅
- **M2b (next)** — the **write seam**. Scope/posture decided via double-review (§2, §4). Must: keep
  read-only as the MCP default; require caller-supplied actor + capability; never emit `'system'`;
  honour the frozen contract; not foreclose HTTP transport or the ingest adapter.
- **HTTP transport (follow-on)** — make `track-mcp` reachable from the k8s platform (streamable-http),
  aligned with `McpCatalogSource`.
- **M3 (design-doc-first)** — h2a coupling: NHI-`signed` writes, decision signatures, journal
  authority; widens `prov.auth` with `'signed'` additively.
- **M5 (later)** — embeddable Svelte report/dossier views in the platform UI.

## 7. Non-negotiables for any sentropic-facing write path
- **Actor is caller-supplied and validated; never `'system'`** (D3, shipped for CLI).
- **`prov` honestly records transport + trust level**; no over-claiming authentication track didn't do.
- **Frozen contract intact**: single-stream / `seq` / `prevHash` / `cmdId` unchanged; any `prov`
  widening is additive and reviewed (an enum value is permanent).
- **Workspace containment**: a delegated host must not be able to write outside its scope (mechanism
  under review — likely a workspace-pinned capability).
