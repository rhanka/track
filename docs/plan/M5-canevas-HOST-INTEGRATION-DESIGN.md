# M5 — CANEVAS host integration (track ↔ sentropic host) — co-design proposal

**Date:** 2026-06-14 · **Status:** track-side co-design draft (WP5 D5 + WP6 M5-host) ·
**For:** the sentropic host (chat-ui / LiveDocument), DS (skins), mermaid-editor (cerclage), the architect.
**Track version:** `@sentropic/track` 0.12.0 · `READ_CONTRACT_VERSION = 1.7.0` · `INGEST_CONTRACT_VERSION = 1.0.0`.

> **Scope.** This is the integration CONTRACT track proposes to the host co-design. track's HALF of M5 —
> the 3 live-out reads, the `item.spec-amend`/`spec.amended` write kind, and the `amendmentTrace`
> projection — is **already shipped in 0.11.2** and is NOT re-specified here (see
> `M5-canevas-DESIGN.md`). This doc builds the host↔track contract ON TOP of the shipped surface, pins
> the exact shapes, and lists the additive-read gaps the host needs. SPEC/DESIGN only — no source change.

## 0. Frame (transcribed from the ratified `M5-canevas-DESIGN.md` — not reinvented)

Two **canevas** embedded in the **host** (chat-ui / LiveDocument is the likely surface; the architect
decides placement): (1) the **`report` view** (kanban→canevas — the AI pushes updates AND the human
creates actions VIA the view), (2) the **decision-dossier view** (decision validation + live spec
amendment with a human/machine diff trace).

**"live" is NOT a track socket.** track stays record-only / append-only / no-clock / no-server.
- **live-out (track→view):** the **HOST** owns the clock + the fs/git watcher. It polls `cursor()`
  and re-reads `canevas()` / `amendmentTrace()` when the cursor moves.
- **live-in (view→track):** a canevas action = **ONE WorkEvent** through the shipped `ingest()` seam,
  `prov.proposed:false` = human / `true` = AI. The human/machine diff trace is a **pure projection over
  `prov`** (`amendmentTrace()`) — zero new event data.

**Boundaries.** render + live loop + optimistic UI = HOST; annotation/cerclage = mermaid-editor;
skins/theme tokens = DS; presentation logic/risk = h2a. **D5 = the track↔host canevas-module
negotiation, NOT a DS decision.**

**Reversibility = compensating events only** (append-only): an inverse `item.spec-amend` / a correcting
WorkEvent; a terminal `decision.outcome` is corrected by a **follow-up** decision, never mutated.

---

## 1. The consumption contract (live-out) — how the host renders + drives the live loop

All three reads are on the shipped `TrackReader` (`@sentropic/track/read`), CLI≡MCP parity
(`track_canevas` / `track_cursor` / `track_amendment_trace`). All are **PURE** (no clock, no socket,
no `git`): the caller supplies `baselineCommit`; the host owns liveness.

### 1.1 `canevas(workspace, { baselineCommit, requireAccepted?, decisionId? }) → CanevasView`

The host's single render input for one workspace. **Exact shipped shape** (`src/read/contract.ts`):

```ts
interface CanevasView {
  workspace: string
  report: Report                              // workspace-scoped buckets + decisions + WP rollup forest
  prov: Record<string, ProvLineage>           // aggregateId → latest-write provenance lineage
  affordances: Record<string, WorkEventKind[]>// aggregateId → LEGAL next WorkEvent kinds (open-action affordances)
  dossier?: DecisionDossierView               // present IFF decisionId supplied (full dossier)
}
interface Report {                            // src/report/build.ts (shipped, reused verbatim)
  buckets: Record<'TO-DO'|'AWAITED'|'DONE'|'DROPPED', ReportRow[]>
  decisions?: DecisionRow[]                   // {id,title,workspace,decisionKind,realization,outcome,accountable?,artifacts?}
  wpTree?: WpNode[]                           // {id,title,label,done,active,dropped,pct,leaves[],children[]} — the %-by-WP forest
}
interface ReportRow {
  id; title; kind; workspace; bucket; realization; acceptance
  priority?; accountable?; engagementRef?; role?  // role present ⇒ a WP container (excluded from flat buckets)
}
interface ProvLineage { origin:'human'|'machine'; proposed; auth; principal?; latestAt }
interface DecisionDossierView { id; title; workspace; outcome:Outcome; dossier:Dossier }  // context/options/qa/outcome/artifacts
```

**Render mapping (host):**
- **`report` view** — `report.buckets` → the kanban columns (`TO-DO`/`AWAITED`/`DONE`/`DROPPED`);
  `report.wpTree` → the %-by-WP rollup forest (each node carries `pct`, `done/active/dropped`, and the
  attached `leaves[]` for the checkbox view); `report.decisions` → the decision lane.
- **prov badge** — for each surfaced aggregate id, `prov[id].origin` (`'human'|'machine'`) drives the
  human/AI badge; `principal`/`auth` drive the attribution chip. (Latest-write provenance only — the
  full lineage is `amendmentTrace`.)
- **affordances** — `affordances[id]` is the exact set of WorkEvent kinds the canevas may offer as
  buttons for that aggregate (it mirrors the real transition machines, so the canevas never offers a
  dead button; the facade re-checks legality on submit, so a superset is harmless).
- **decision-dossier view** — call with `decisionId`; render `dossier.dossier` (context, options[],
  qa[], recommendation?, resultingSpecChange?, artifacts[]) + `dossier.outcome`.

`canevas` re-runs `buildReport` (global) then filters to `workspace` (buckets, decisions, and the WP
forest). **The whole workspace is materialized each call** — see the §3 pagination gap for large boards.

### 1.2 The LIVE loop — `cursor()` / `changesSince(cursor)`

```ts
interface Cursor      { head: Sha256 | null; count: number }           // head = log-tail contentHash; O(tail)
interface CursorDelta { changed: boolean; head: Sha256 | null; count } // changed ⇒ re-materialize
```

The host owns the clock and the watcher. Loop:
1. hold the `Cursor` from the last `canevas()` read;
2. on its own cadence (a fs/git watch event, or a poll tick), call `changesSince(heldCursor)`;
3. if `changed`, re-read `canevas()` (and any open `amendmentTrace()`), then store the new cursor.

The cursor moves **iff the log grew** (`head` hash OR `count` differ). This is the ONLY liveness
primitive — track exposes no stream, no socket, no long-poll. **All cadence/back-pressure/coalescing is
the host's** (see §3 for a proposed delta read, and §5 for the cadence open question).

### 1.3 `amendmentTrace(aggregateId) → AmendmentStep[]` — the human/machine diff

```ts
interface AmendmentStep {
  seq; at; by; kind: EventType            // spec.amended | dossier.revised | decision.artifact-added | decision.outcome
  prov: { proposed; auth; principal? }
  origin: 'human' | 'machine'             // DERIVED from prov.proposed — true ⇒ machine, false ⇒ human
  summary?; patchRef?; proposalRef?       // patchRef = resultHash; proposalRef = the AI proposal it accepts
}
```

Ordered by `seq`, PURE replay. The diff timeline renders one row per step; `origin` drives the
human/machine lane. **An AI proposal (`proposed:true`, with a `proposalRef`) AND a human acceptance
(referencing the same `proposalRef`) BOTH appear — the machine origin is never laundered away.** This is
free: zero new event data, derived entirely from `prov`.

---

## 2. The action contract (live-in) — canevas action → ONE WorkEvent

Every canevas action is ONE `WorkEvent` submitted through the shipped `ingest(events, ctx, store)` seam
(`src/ingest/ingest.ts`). The envelope is **neutral** (`src/ingest/contract.ts`):

```ts
interface WorkEvent { v: 1; kind: WorkEventKind; payload: Record<string,unknown>; clientToken?: string }
```

**The WHO/trust are NOT on the event** — they come from the channel `IngestContext` set when the channel
opens (`WORK_EVENT_ENVELOPE_KEYS = ['v','kind','payload','clientToken']` — any `actor`/`proposed`/… key
is rejected fail-closed):

```ts
interface IngestContext {
  by: ActorId            // recorded as `by`
  workspace: string      // PINNED — containment is enforced vs folded state (load-bearing security property)
  prov: Provenance       // { transport, proposed, auth, principal?, sig? } — its `auth` gates binding kinds
  allowedKinds?: ReadonlySet<WorkEventKind>  // capability allowlist
}
```

**`prov.proposed` is the human/AI bit:** `false` for a human-driven canevas action, `true` for an
AI-proposed one. **The human/machine trace is entirely a function of this bit** — set it honestly on the
channel and `amendmentTrace`/`prov` are correct for free.

### 2.1 The canevas → WorkEvent map (every action)

| Canevas action | `kind` | key payload fields | `settles` | binding? |
|---|---|---|---|---|
| create card | `item.create` | `kind∈{feature,bug,chore}, title, workspace, parentId?, role?, scope?` | never | no |
| move / reparent | `item.reparent` | `itemId, parentId?` (absent ⇒ detach to root) | always | **yes** |
| set spec status | `item.spec` | `itemId, to∈{to-specify,specified}` | never | no |
| set status (start/done/cancel) | `item.realize` | `itemId, to∈{in-progress,done,cancelled}` | realize-terminal | **yes if to∈{done,cancelled}** |
| raise blocker | `blocker.raise` | `targetId, kind∈{decision,dependency}, ref?, scope?, engagementRef?` | never | no |
| resolve blocker | `blocker.resolve` | `blockerId` | always | **yes** |
| add acceptance criterion | `acceptance.criterion` | `itemId, statement` | never | no |
| link / waive acceptance | `acceptance.link` / `acceptance.waive` | `criterionId, …` | never / always | link no, waive **yes** |
| set priority | `priority.assess` | `itemId, userBusinessValue, timeCriticality, riskReduction…, jobSize` | never | no |
| validate decision | `decision.outcome` | `decisionId, to∈{go,no-go,deferred}` | always | **yes** |
| attach evidence | `decision.add-artifact` | `decisionId, artifact` (h2a-decision-dossier \| rendered-view \| mockup) | always | **yes** |
| revise dossier (coarse) | `decision.dossier` | `decisionId, dossier` (whole-Dossier rewrite — checkpoint only) | never | no |
| **live spec edit** | **`item.spec-amend`** | `itemId, baseHash, patch:JsonPatch, resultHash, decisionId?, liveDocRef?, proposalRef?, summary?` | always | **yes** |

**`item.spec-amend` is the live-amendment primitive** (`src/model/spec-amend.ts`). track records the
RFC-6902 `patch` **VERBATIM** and NEVER applies/validates it; `baseHash`/`resultHash` are **opaque
integrity tags** (the spec document lives in the host's LiveDocument). It is per-patch and append-only,
so it is **concurrent-safe** where `decision.dossier`'s whole-Dossier rewrite is a lost-update hazard.
When an AI proposes (`prov.proposed:true`, with `proposalRef`) and a human later amends referencing that
`proposalRef`, BOTH stay in the trace — the host MUST set `proposalRef` to preserve the lineage.

### 2.2 The binding gate (host must honor)

A **binding** ("settling") write — `reparent`, `realize→done/cancelled`, `decision.outcome`,
`add-artifact`, `waive`, `blocker.resolve`, `spec-amend`, plus `evidence` kinds — is allowed **only on
an authenticated channel** (`prov.auth ∈ {local-user, signed}`). An `unauthenticated` channel may only
create/prepare. So the canevas's decision-validation and live-spec-edit affordances **require the host's
submit channel to be authenticated**. (See §5 — submit channel.)

### 2.3 Optimistic UI + idempotent retry (0.12.0 — race-safe)

A WorkEvent carrying a **`clientToken`** is idempotent: a retry with the same token is **skipped** and
returns the **original** assigned id. As of **0.12.0** this is keyed on **`(workspace, clientToken)`**
and re-checked **under the store's cross-process file lock** (`appendCommand`'s `dedupe` hook), so it is
authoritative even when two ingests race — a concurrent CREATE-retry (which re-mints the aggregateId each
attempt) still dedups to ONE event. This is exactly what optimistic UI needs:

- the host mints a stable `clientToken` per user gesture (e.g. a UUID), submits optimistically, and
  **retries safely** on a network/timeout failure — no duplicate card, no double-validation;
- the returned id reconciles the optimistic placeholder against the real aggregate id;
- workspace is IN the key ⇒ a token from workspace V can NEVER suppress a write in W (no cross-tenant
  write-suppression).

> The host MUST NOT reuse a `clientToken` across DIFFERENT command bodies — the store rejects a token
> reused across a different aggregate set fail-closed. One token = one gesture.

---

## 3. Gap analysis — what track must ADDITIONALLY expose

The shipped 4 reads (`canevas` / `cursor` / `changesSince` / `amendmentTrace`) cover the **core** render
+ live + diff loop. They are sufficient for a small/medium board with a coarse "re-read on any change"
loop. For a production host they leave four concrete gaps. **All proposed reads are clearly marked, must
stay additive / read-only / clockless / pure, and bump `READ_CONTRACT_VERSION` by a minor only.**

| # | Read | Status | Host need it answers |
|---|---|---|---|
| R1 | `canevas(workspace, {baselineCommit, decisionId?})` | **SHIPPED 1.7.0** | one-workspace materialized render input |
| R2 | `cursor()` | **SHIPPED 1.7.0** | the liveness primitive (log-tail hash + count) |
| R3 | `changesSince(cursor)` | **SHIPPED 1.7.0** | "did the log grow since my last read?" |
| R4 | `amendmentTrace(aggregateId)` | **SHIPPED 1.7.0** | the prov-tagged human/machine diff |
| **P1** | **`canevas` pagination/filter** — `canevas(ws,{…, bucket?, parentId?, limit?, after?})` → a windowed `CanevasView` | **PROPOSED-ADDITIVE** | a large board re-materializes the whole workspace on every cursor move (R1 is O(log) + full filter each call). The host needs to fetch/refresh ONE column, ONE WP subtree, or a bounded page. |
| **P2** | **`affordancesFor(aggregateId, {baselineCommit})` → `WorkEventKind[]`** | **PROPOSED-ADDITIVE** | the host needs the open-action affordance list for ONE item without re-materializing the whole `canevas` (the optimistic-UI "what can I do here?" probe on a single card; today affordances ride only on the full `CanevasView`). |
| **P3** | **`changesSince(cursor)` → a DELTA shape** — extend `CursorDelta` with `changedAggregateIds?: string[]` (the aggregate ids whose events landed after the held cursor) | **PROPOSED-ADDITIVE** | today `changed:true` forces a FULL re-materialization. A delta lets the host re-read only the touched aggregates (pairs with P1) — cheaper live loop, less UI churn. Still pure, still O(tail-since-cursor). |
| **P4** | **a per-view dossier projection** — `decisionDossier(decisionId, {baselineCommit}) → DecisionDossierView` (standalone) | **PROPOSED-ADDITIVE** | the decision-dossier view often opens WITHOUT the surrounding board; calling `canevas` just to get `view.dossier` materializes the whole workspace. A direct dossier read is cheaper and matches the view boundary. (P4 is low-priority — `canevas({decisionId})` already works; this is an efficiency/ergonomics split.) |

**Deliberately NOT proposed (stays the host's job, per the prime directive):** any push/stream/socket
read, any long-poll that blocks (track is clockless — it cannot wait), any clock-bearing "since
timestamp" read (use the cursor), any write over MCP (MCP stays read-only — see §5). Liveness delivery
is the host runtime; track only answers "what is true now" and "did it change."

**Recommended minimal set for M5-host v1:** **P1** (pagination — the only true scaling blocker) and
**P3** (delta — the live-loop cost fix). **P2/P4** are ergonomic and can ship later or be served by the
existing reads.

---

## 4. WP5 (D5) — the canevas-module negotiation (host + DS + mermaid co-own)

D5 is **the track↔host canevas-module shape**, not a DS theme decision. The module is co-owned across
four boundaries; track's job is to name where its affordances plug in and to hold the contract stable.

| Layer | Owner | Owns | Consumes from track |
|---|---|---|---|
| **render + live loop + optimistic UI** | **HOST** (chat-ui / LiveDocument) | the canevas component, the kanban/dossier layout, the `cursor` watch loop, the optimistic-UI + clientToken reconciliation, the submit channel | `canevas` / `cursor` / `changesSince` / `amendmentTrace` (+ P1–P4); submits via `ingest()` |
| **skin / theme tokens** | **DS** | colors, spacing, typography, the human/machine badge styling, the bucket/WP-rollup visual language | nothing directly — DS skins the host's render output; the `origin:'human'\|'machine'` field is the only track datum that drives a DS token choice |
| **cerclage / annotation** | **mermaid-editor** | the diagram annotation + cerclage overlay reused on the canevas (highlight a WP subtree, circle a decision, annotate a diff) | the aggregate ids + `wpTree` structure from `canevas` to anchor annotations; nothing track-specific beyond stable ids |
| **presentation logic / risk** | **h2a** | risk framing, what to surface/escalate, decision presentation | `prov` / `amendmentTrace` (the human/machine provenance is the risk signal) |

**Track's plug-in points in the module (the negotiation track brings):**
1. **The render datum contract** is §1 — track guarantees `CanevasView` / `Cursor` / `AmendmentStep`
   are additive-only within the major (`READ_CONTRACT_VERSION` minor bumps; consumers gate on
   `reader.contractVersion`). The host + DS + mermaid build against these shapes.
2. **The affordance contract** is `affordances[id]: WorkEventKind[]` — the canonical list of legal
   buttons per aggregate. The host renders buttons FROM this; DS skins them; the facade re-checks on
   submit. This is the seam where "what the canevas may offer" is owned by track (legality) and "how it
   looks/feels" is owned by host+DS.
3. **The prov/origin contract** is `origin:'human'|'machine'` (+ `auth`/`principal`) — the single field
   the human/machine diff badge, the DS badge token, and the h2a risk view all key off.
4. **The submit contract** is the WorkEvent map (§2) — the host translates a canevas gesture into ONE
   WorkEvent + a `clientToken`. track owns the kinds/payload schema (`INGEST_CONTRACT_VERSION`); the
   host owns the gesture→WorkEvent translation and the channel.

**Open negotiation item for D5:** the **module package boundary** — does the canevas component live as a
host package that imports `@sentropic/track/read` (types) + the ingest seam, or as a thinner component
fed by a host service layer (§5)? track's preference: the **render datum types** (`@sentropic/track/read`)
are imported directly (they are the contract); the **submit** goes through a host service so the channel
auth/context is owned in one place. **The architect decides.**

---

## 5. Open questions for the host / DS / architect

1. **Placement — chat-ui vs LiveDocument (architect's call).** The frame names LiveDocument as the
   likely surface for the live spec document (it's where `liveDocRef` / `baseHash` / `resultHash`
   originate). Is the `report` canevas a chat-ui kanban surface and the dossier canevas a LiveDocument
   surface, or both in one? track is placement-agnostic — but `item.spec-amend`'s `liveDocRef` +
   hash semantics assume a LiveDocument-like document store owns the spec text. **Architect decides;
   track only needs a stable `liveDocRef` + the host-computed `baseHash`/`resultHash`.**

2. **The authenticated submit channel — lib import vs ingest gateway (ties to deferred M3-HTTP).**
   This is the single biggest unresolved seam. Findings:
   - **MCP is read-only** — the MCP server exposes NO write/ingest tool. The canevas cannot submit over
     MCP. (This is by design — MCP stays a read surface.)
   - **`ingest()` is NOT in the package `exports`** — `package.json` exposes only `.` (barrel) and
     `./read`. The barrel does **not** re-export `ingest`/`IngestContext`/`WorkEvent` either; today the
     only in-tree caller is the CLI (`track ingest <file.jsonl>`, a local-file, `local-user`,
     `transport:'import'` channel). **So a host cannot import `ingest()` as the package stands.**
   - track is **record-only and does not host HTTP** (M3 is library-import; `prov.transport:'http'`
     merely records that the trusted caller received the write over HTTP — track never opens a port).
   - **The decision the host co-design must take:** EITHER (a) track adds an additive `./ingest` export
     so a trusted host service imports `ingest()` directly and builds the `IngestContext` (setting
     `prov.proposed`, `auth`, `principal` from the platform IdP) — minimal, in-process, no new server;
     OR (b) a separate **ingest gateway** (the deferred **M3-HTTP** work) fronts `ingest()` over an
     authenticated transport, and the host POSTs WorkEvents. (a) is the cheap path and unblocks M5-host
     today; (b) is the multi-principal future. **Recommend (a) for M5-host v1** (additive `./ingest`
     export, in-process, host owns auth), keeping (b) for M3. *This is the one track-side change M5-host
     needs beyond reads — flagged here, NOT spec'd, for the co-design + the architect to ratify.*
   - Whoever owns the channel sets `prov.proposed` (human/AI), `auth` (`local-user` for a local host,
     `signed` once an IdP attests `principal`), and the `workspace` pin. **Binding affordances
     (decision validation, live spec edit) need `auth ∈ {local-user,signed}` — an `unauthenticated`
     channel cannot validate decisions or amend specs.**

3. **Optimistic-UI reconciliation against the append-only log.** The host renders optimistically, then
   reconciles when the cursor moves and `canevas` re-materializes. The `(workspace, clientToken)`
   idempotency (0.12.0, under-lock, race-safe) makes the retry safe and the returned id stable — so the
   host maps `clientToken → placeholder → real id`. **Open:** does the host want the assigned-id echo
   inline on the submit response (it gets `IngestResult.ids` from `ingest()` directly in path (a)), or
   does it reconcile purely by re-reading `canevas`? And how does it render a REJECTED optimistic action
   (an `IngestError` — e.g. a binding write on an unauthenticated channel, or a containment violation)?
   Reversibility is compensating-only: a wrong applied action is corrected by an INVERSE WorkEvent
   (inverse `item.spec-amend`, a follow-up `decision.outcome`), never a mutation — the host's "undo" is
   a new event, not a delete.

4. **The live-loop cadence / cost.** track gives only `cursor()` (O(tail)) + `changesSince`. The host
   owns the watcher and the poll cadence. **Open:** what cadence (fs/git watch vs N-second poll), and
   does the host want **P3** (the `changedAggregateIds` delta) and **P1** (pagination) to avoid a full
   workspace re-materialization on every keystroke-sized `spec.amended`? On a busy live-spec-edit
   session the cursor moves on every patch; a full `canevas` re-read per patch is the cost risk.
   **Recommend P1 + P3 land before a large-board / heavy-live-edit deployment.**

5. **DS token surface from track data (minor).** The only track datum DS keys off is
   `origin:'human'|'machine'` (+ `auth`/`principal`) for the provenance badge. Confirm DS wants nothing
   else from track (it shouldn't — DS skins the host's render, not track's data).

---

## 6. Summary

- track's M5 HALF is **shipped in 0.11.2 / 0.12.0**: 4 live-out reads (`canevas`, `cursor`,
  `changesSince`, `amendmentTrace`), the `item.spec-amend`→`spec.amended` write kind, and the
  `amendmentTrace` human/machine diff. This doc is the **host-integration contract on top**, not a re-spec.
- **Live-out** = the HOST polls `cursor()` (owns the clock + fs/git watcher) and re-reads `canevas()` /
  `amendmentTrace()` on change; track is clockless, socketless, push-less. All shapes pinned to the
  shipped `src/read/contract.ts`.
- **Live-in** = each canevas action is ONE `WorkEvent` (neutral envelope; WHO/trust from the channel
  `IngestContext`) through `ingest()`. `prov.proposed` is the human/AI bit and the human/machine trace
  is free from it. The 0.12.0 `(workspace, clientToken)` under-lock idempotency makes optimistic-UI
  retries race-safe.
- **The one track-side change M5-host needs beyond reads is a submit channel:** MCP is read-only and
  `ingest()` is not currently in the package `exports` — track should add an additive `./ingest` export
  (in-process, host owns auth) for v1, with the M3-HTTP gateway as the multi-principal future. Flagged
  for the co-design + architect, NOT spec'd here.
- **D5** frames the canevas module as host (render/live/optimistic) + DS (skins) + mermaid (cerclage) +
  h2a (risk), with track's four plug-in points: the render datum contract, the `affordances` legality
  contract, the `origin` provenance contract, and the WorkEvent submit contract.
- **PROPOSED-ADDITIVE track reads the host needs** (all additive / read-only / clockless / pure,
  `READ_CONTRACT_VERSION` minor bump):
  - **P1 — paginated/filtered `canevas`** (`{bucket?, parentId?, limit?, after?}`): scaling for large
    boards (the only true blocker).
  - **P2 — `affordancesFor(aggregateId)`**: single-card open-action probe without full re-materialization.
  - **P3 — `changesSince` delta** (`changedAggregateIds[]`): re-read only touched aggregates → cheaper
    live loop.
  - **P4 — standalone `decisionDossier(decisionId)`**: the dossier view without the surrounding board
    (low-priority; `canevas({decisionId})` already covers it).

  **Recommended for M5-host v1: P1 + P3.** (P2/P4 are ergonomic; the shipped 4 reads already serve the
  core loop.)
