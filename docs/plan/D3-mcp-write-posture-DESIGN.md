# D3 — MCP write actor/auth posture (gates M2b)

> Decision doc for PLAN-v2 **D3** (flagged non-reversible). Double-consulted **Opus 4.8 + Codex gpt-5.5 xhigh** (`/tmp/codex-D3.log`, Opus agent transcript). Status: **awaiting owner sign-off.** No code built — M2b stays unbuilt until this is decided.

## Why it's irreversible
`by: ActorId` is inside `EventCore`, and `contentHash` covers the whole core (`events/types.ts`, SPEC §3). So **whatever attribution an MCP write records is frozen into the chain forever** — there is no post-hoc re-attribution. The irreversible commitment is *the shape + meaning of provenance*, not whether a write tool is toggled on. (`'system'` is only a *facade default* today — `track.ts` `opts.by ?? 'system'` — and the CLI also writes unattributed, a latent lie that only bites once a second, non-human writer exists.)

## State of the art (both experts converged)
- **Ambient authority → capability (POLA/ocap):** a stdio server inherits the launcher's full rights; the authority to write must be *explicitly conferred + presented*, never implicit in "the server is running."
- **Confused deputy:** if the *server* picks `by`, it launders the agent's writes into infra writes. The fix is to **bind attribution to the caller** — the caller names the actor; the server refuses to invent one.
- **Multi-actor event sourcing:** never collapse provenance into one field — separate `actor` (on whose behalf) / causation (`cmdId`) / correlation / transport-source. `'system'` is reserved for genuinely autonomous internal events, never "unknown caller."
- **MCP 1.x auth:** stdio = trusted-local, **no per-call principal**; only HTTP carries OAuth bearer/resource-server tokens. A stdio server that *writes* operates exactly where MCP gives no principal.
- **Agent write-tool gating (industry):** off-by-default + allow-list + human-in-the-loop for binding actions + dry-run + signed/attributed actions + per-tool tiers. Maps onto track's prime directive: **LLM proposes, deterministic rules decide; track records, never decides.**
- **Key truth:** caller-supplied actor is **attribution, not authentication** — acceptable only if the record is explicit that the write is *unverified*. Real authentication arrives in **M3/h2a** (ed25519-signed journal events + an instance registry of PRINCIPAL/CONDUCTOR/AGENT — confirmed via the `h2a_sign`/`h2a_register_instance` tools).

## Convergent mechanics (decide as the frozen contract)
1. Writes **off by default**; `track-mcp` lists only read tools unless launched with an explicit **write capability** (binds events path + allowed actors + allowed scopes [+ optional expiry/id]).
2. Every write call **must** supply `actor`; validated as a **namespaced, non-empty, allow-listed** id (e.g. `human:antoinefa`, `agent:codex-cli`, `ci:github-actions`, later `h2a:<principal>`); **literal `system` rejected** on the MCP write path. This becomes the event `by`.
3. Each MCP-originated event carries **hash-covered provenance** marking it `transport: mcp-stdio`, `proposed: true` (agent-proposed), `auth: unauthenticated` (asserted, not verified) — so a reviewer can read the trust level of every write.
4. **Per-tool scopes/tiers:** `item.create`/`priority.assess` are proposal-grade; **binding tools** (`decision.outcome`, `realization → done/rejected`) are withheld hardest / human-approval (an agent settling a Decision = "LLM deciding" — forbidden by the prime directive).
5. **Forward-compat:** the provenance slot is where M3 adds `sig`/`principal` and flips `auth: unauthenticated → signed`. Additive (D7) — M3 upgrades attribution without contradicting any M2b record.
6. **Reject C** (bespoke per-call token): over stdio it becomes a mini-IdP that duplicates h2a and re-introduces confused-deputy/token-passthrough bugs.

## The two divergences (the actual choices)
- **(a) Enable now vs defer enablement to M3.** *Opus:* ship **read-only now (A)**, freeze the contract, enable writes at M3 when the actor is *authenticated* (or sooner behind the gate if a concrete consumer needs it). *Codex:* ship **gated writes now (B+local-ocap)** — pragmatic SOTA for a local tool, accepting *marked, unverified* actors.
- **(b) Where provenance lives.** *Opus:* a **new top-level `prov` field in the event core** (keeps `by` pure, provenance unstrippable, clean h2a-sig slot). *Codex:* **payload metadata** (avoids touching the core; "reversible enough").

## Owner-level sub-decisions (yours)
1. **May MCP agents write at all before h2a authentication exists?** (The core value call — is a *marked, unverified* principal acceptable in an immutable system of record?)
2. Which actors/scopes are legitimate; is `decision.outcome` ever agent-settable (recommend: never)?
3. The frozen **vocabulary**: `prov` field shape, `auth` enum, what `'system'` now means.
4. **Fix the CLI's latent `'system'` lie in the same change** (start stamping a real `by` + `prov:{transport:cli,auth:local-user}`)? Both experts recommend yes — it makes human-CLI vs agent-MCP writes honestly distinguishable.

## Recommendation
**Hybrid A→B.** Freeze the convergent contract **now** (dedicated `prov` core field + mandatory allow-listed `by`, never `'system'`); ship MCP **read-only by default**; enable write tools only behind the explicit capability gate, **ideally at M3** when h2a makes the actor *authenticated* rather than merely *asserted* — or sooner if a concrete consumer needs unattended agent write-back. Fix the CLI `'system'` lie in the same stroke. This buys A's zero lock-in + confused-deputy immunity today, decides the one irreversible thing (the `prov`/`by` contract) once and forward-compatibly, and makes "enable agent writes" a reversible config flip. **Headline: ship read-only, freeze the B contract, enable behind a gate (prefer M3).**
