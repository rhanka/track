# M3 prelude — dependencies + RACI + contractualization (track ⟷ h2a), design

Status: **design, double-consulted → decided.** Codex gpt-5.5 xhigh + Opus 4.8 both returned a strongly
convergent recommendation. Answers the owner's question: *does track model dependencies + the "who" (RACI)
well enough for contractualized, scheduled execution, intra- AND extra-repo, with a clear intra/extra
differentiation?* — **today: no; with this minimal additive lot: yes.** Resolves **D6**.

## The load-bearing finding
The boundary is **already specified** in track's own sources: `SPEC.md` (`WorkPackage = h2a ENGAGEMENT`,
degraded to a derived view; `engagementRef`/`taskRef` reserved) and `INTENTION.md` (anticipated h2a
evolution #1 = "a journal entry correlated to a track `Item.id`"). Those fields were **never implemented**
(placeholder prose). So this is not new modeling — it **lands the reference that was always the plan**, plus
two small additive axes (RACI, dependency scope). Everything is additive-by-construction; the prime
directive holds (**track records; it does not coordinate, decide, schedule, or verify signatures**).

## The model (minimal, additive — the `prov`/`clientToken` pattern)
All additions are **payload fields / enum values on EXISTING event types** — no new event type, no
`seq`/`prevHash`/`contentHash`/`cmd` change; `canonicalize` drops `undefined`, so **pre-existing events hash
byte-identically** (proven by `prov` 0.2.0 and `clientToken` 0.4.0).

| Addition | On (event) | Purpose |
|---|---|---|
| `accountable?: ActorId` | `item.created`, `decision.created` | **RACI-A** — the single neck-to-grab. A Decision's `accountable` **is its sponsor** (resolves D6). |
| `responsible?: ActorId[]` | `item.created` | **RACI-R** — the doers. |
| `engagementRef?: string` | `item.created`, `decision.created`, `blocker.opened` | Opaque ref to an h2a `engagementId` — the link to the executable CONTRACT. **Present ⇒ a contract exists** (orthogonal to intra/extra). |
| `scope?: 'intra' \| 'extra'` | `blocker.opened` (dependency only) | The intra-repo vs extra-repo discriminant. Absent ⇒ `'intra'`. |

**Cut (not built this lot):** `consulted`/`informed` (notification routing = coordination; h2a `roleBindings`
covers richer roles); a separate `assignment`/`reassignment` event (defer until reassignment history is a
real need); a new `external-signal` resolution rule (redundant — `scope:'extra'` is the discriminant);
`dueAt`/scheduling field (reserved, §Scheduling); `prov.auth:'signed'` (that's the M3 channel); WP as a
first-class aggregate (stays derived).

## Intra vs extra dependencies
- **`scope:'intra'` (default)** — unchanged: a `dependency` blocker's `ref` MUST be a local item; the
  `openBlocker` local-ref check (`track.ts:295`) is untouched. This is today's item↔item dependency
  (`linked-done`/`linked-accepted`/`manual`, revocable).
- **`scope:'extra'`** — relax the local-ref check **only on this branch**: `ref` is **omitted**, and
  **`engagementRef` is REQUIRED** (the opaque h2a `engagementId`). `ref` is never overloaded with a foreign
  string (that would poison `blocker-status.ts`'s `acceptanceStatus(state, blocker.ref, …)` and every
  `state.items.get(ref)`). Resolution is **`manual`** only — track never polls or infers h2a state; a human,
  or the M3 bridge (which verifies the h2a engagement settled), writes the `blocker.resolved`.
- **Fold-time assertion (fail-closed):** `scope:'extra'` ⇒ `ref` absent ∧ `engagementRef` present; else a
  validation finding. Keeps the relaxed branch from loosening any existing path.

## The track ⟷ h2a boundary (the contractualization answer)
- **track owns the RECORD:** items, decisions, intra-repo dependency blockers, the RACI fields, a **local
  projection of external commitments** (`scope:'extra'` blocker + `engagementRef`), and it **records**
  `prov.auth='signed'` as a *fact about a write it received* (it never computes trust).
- **h2a owns the CONTRACT:** `ENGAGEMENT` (charter / successCriteria / roleBindings / amendments),
  negotiation, Ed25519 signatures — usable **intra-repo optionally** (a signed internal commitment carries
  an `engagementRef` too) and **extra-repo required**. The discriminant for "is there a contract" is
  **`engagementRef` present**, NOT intra-vs-extra — so h2a applies intra-repo when wanted (the owner's point).
- **Articulation = a stable bidirectional reference:** track carries `engagementRef → h2a engagementId`;
  h2a's journal carries the `track Item.id` (anticipated h2a evolution #1 — additive on h2a's open-bodied
  journal payload). 
- **track MUST NOT absorb:** the contract body, negotiation state, signature *verification* (it records the
  channel's attestation, no Ed25519 in track), notification, scheduling, or enforcement.

## Scheduling / "programmed execution"
Record-only ⇒ **a passive `dueAt?` field at most, RESERVED not built** this lot. track must never run a
timer, notify, escalate, auto-fail, or transition on a date — that is non-deterministic, non-event-sourced
behavior it cannot host. The *scheduled execution* lives in h2a's `ENFORCEMENT_PLAN` + the harness; track
records *that a dated commitment exists*, a consumer drives the schedule.

## D6 — RESOLVED
Drop the separate `sponsor` field (option B). The Decision's **`accountable`** field **is the sponsor**
(option A, as a first-class field — strictly better than `by`-of-outcome, which is channel-pinned). Option
C (a cryptographically-bound signed principal) lands in M3 when `prov.auth='signed'`. One field, three
milestones, zero duplication.

## Lots & sequencing
- **Lot A (this lot — standalone, additive, pre-M3):** `accountable?`/`responsible?` on item.created;
  `accountable?`/`engagementRef?` on decision.created; `engagementRef?`/`scope?` on blocker.opened; the
  `openBlocker` extra-scope relaxation + fold assertion; fold/report surfacing of `accountable`. CLI +
  WorkEvent-schema + `mapWorkEvent` additions. **Works with no auth channel** (a human opens an `extra` dep
  and resolves it manually today). Gate: additive contract snapshot; old logs hash-identical; cross-scope
  validation; CLI≡ingest parity for the new fields.
- **Lot B (M3 auth channel) — SHIPPED, shape A (library-import), owner-ratified option ①.** track stays a
  library; **the verified caller** (the platform API / the h2a bridge — which already verified the OIDC JWT
  or the NHI Ed25519 signature) constructs a signed `IngestContext` and calls the **same** `ingest()`. track
  **RECORDS** the attestation; it **never verifies** (record-only, h2a-free). NO network service, NO new
  dependency. Delivered: `Provenance` widened additively — `auth += 'signed'`, `transport += 'http'`,
  optional `principal?` (NHI id / JWT `sub`) and `sig?: {alg,value,by}` (mirrors `H2ASignature`, recorded
  for audit, NOT a signature over the EventCore, NOT a bearer token); the prov snapshot deep-clones the
  nested `sig` (`structuredClone`) to preserve D3's inert-snapshot guarantee; `BINDING_AUTH` already admits
  `'signed'`, so a signed channel may perform binding writes with no `ingest` change, and workspace
  containment still holds for `signed`.
  - **Signed-ctx construction recipe (for the caller):** after verifying the principal, build
    `ingest(events, { by: verifiedPrincipalId, workspace, prov: { transport: 'http'|'import', proposed: false,
    auth: 'signed', principal: verifiedPrincipalId, sig?: <H2ASignature> } }, store)`. track does no
    verification; it records `prov.auth:'signed'` + `principal` (+ `sig`). The CLI is NOT extended (it stays
    `transport:'cli', auth:'local-user'`) — signed contexts are constructed programmatically by the caller.
- **Lot C (h2a bridge):** the automated path — an h2a engagement reaching `accepted`/`stabilized` crosses
  the (M3) signed channel as a neutral `blocker.resolved` WorkEvent carrying the `engagementRef`. Gated on
  Lot B.

## Frozen-contract risk
Low and precedented — all additions are payload/enum-only on existing event types (hash-identical for old
events). The single risk is the conditional `openBlocker` ref-relaxation; mitigated by the strict
`extra ⇒ no ref + engagementRef` fold assertion (fail-closed). Reviews to be archived at
`docs/reviews/M3-deps-{codex,opus}.md`.
