# DESIGN — Demand lifecycle (Mode A), owner-ratified

**Status:** ratified design (owner approved all précos 2026-06-21). Pair: Codex 5.5xhigh + Opus 4.8max
(converged). This is the BUILD SPEC. Supersedes the open questions in `intake-registry-multiactor-ANALYSIS.md`.

## Decision (owner)
**Mode A**: @sentropic/track owns the full DEMAND lifecycle from `raised` (issue) through `delivered` —
tracking starts at the issue, demands are qualified before being agreed, nothing is untracked. The "who is
handling" (`handler`, the h2a instance id) is logged at every step. Additive to the frozen event contract.

## Orthogonal axes (a demand is NOT one mega-status)
1. **Lifecycle** (progress): the 7 statuses + off-ramps (below).
2. **Type** (nature): `feature | defect | chore | …` — additive `type` on the demand, carried to the item `kind`.
   - **`defect` vs `bug` rule:** `defect` = promoted from a `DemandType:'defect'` demand (carries the `concerns`
     regression back-link; reachable ONLY via demand promotion, never a direct `item.create`); `bug` = the legacy
     ad-hoc kind. They stay DISTINCT; the `bug`→`defect` deprecation is deferred to a later lot. `defect` is
     intentionally promotion-only ⇒ NOT added to the ingest `ITEM_KINDS` / MCP direct-create enums.
3. **Blocking** (AWAITED overlay): a **user decision** (`decision` aggregate, pending→go/no-go) OR a dependency
   OR a **UAT-gate** opens a **blocker** → the demand reads AWAITED at ANY lifecycle status. **Reuses the existing
   blocker mechanism — NO new lifecycle status for decisions/UAT.**
4. **Acceptance / UAT-readiness**: criteria + render-backed proof, fail-closed (standing rule
   uat-entry-criteria-v1). **Reuses the existing acceptance axis.** A failed UAT-gate commonly raises a `defect`
   demand (same lifecycle).

## Model — new `demand` aggregate (D1, ratified)
A `demand` is a new first-class aggregate that PROMOTES into an `item` at `agreed`. Rationale: the backlog stays
honest (only agreed work is an item); rejected/duplicate/parked demands never pollute item reads; 1:N fan-out +
dedup need a stable non-item parent; mirrors the `decision`-aggregate pattern.

```ts
// src/model/demand.ts (NEW)
export type DemandId = Ulid
export type DemandType = 'feature' | 'defect' | 'chore'         // additive; extensible
export type DemandStatus = 'raised'|'qualifying'|'agreed'|'rejected'|'duplicate'|'parked'
export interface DemandState {
  id: DemandId
  workspace: string
  type: DemandType
  raw: { text: string; title?: string; format?: 'plain'|'markdown' }   // t=0 capture, immutable
  source: { kind:'human'|'agent'|'h2a'|'import'|'external'; actor?: ActorId; ref?: string; locator?: string }
  status: DemandStatus
  itemIds?: ItemId[]                          // set at agreed (1..N promoted items)
  duplicateOf?: { kind:'demand'|'item'; id:string }
  rejectReason?: string
  parkReason?: string
  concerns?: { kind:'item'; id:ItemId }       // a defect links the delivered item it regresses
  sourceKey?: string                          // optional stable dedup key (e.g. issue id)
  links?: Link[]
}
```

## State machine (lifecycle axis)
```
none ─► raised ─► qualifying ─► agreed ─► (item lifecycle owns 4..7)
                     │
                     ├─► rejected   (terminal)
                     ├─► duplicate  (terminal → survivor)
                     └─► parked ─► qualifying   (re-entrant)
```
- `raised → qualifying` is mandatory before any off-ramp (every outcome is attributable to a handler).
- `agreed` is terminal on the DEMAND axis = the PIVOT; statuses 4–7 are the EXISTING item axes, UNCHANGED:
  `specifying` = item `specStatus:'to-specify'` + a live spec attempt (lease/`spec.started`); `specified` =
  existing `spec.transition→specified`; `in-progress`/`delivered` = existing `realization.transition`; delivery
  acceptance via the existing criterion/evidence/run machinery.

## Events (additive — old logs replay byte-identical via canonicalize/undefined)
New aggregate `'demand'`; new persisted kinds + WorkEvent kinds:

| WorkEvent kind | Event | settles | payload |
|---|---|---|---|
| `demand.raise` | `demand.raised` | **never** (anyone may capture) | `{type, raw, source, handler, sourceKey?, concerns?}` |
| `demand.claim` | `demand.qualifying-started` | always | `{handler, leaseId?}` |
| `demand.agree` | `demand.agreed` **+** `item.created{demandId,kind=type}` *(1 atomic batch)* | always | `{handler, itemId|itemIds, qualification?}` |
| `demand.disposition` | `demand.disposition` | always | `{outcome:'rejected'|'duplicate'|'parked', handler, reason, duplicateOf?, parkedUntil?}` |
| `spec.claim` | `spec.started` | always | `{itemId, handler, leaseId?, attemptId?}` |
| `spec.abandon` | `spec.abandoned` | always | `{itemId, handler, leaseId?, reason}` |

Additive optional fields on existing payloads: `item.created{demandId?, }`; `spec.transition{handler?,leaseId?}`;
`realization.transition{handler?,leaseId?}`. Add `'defect'` to the item `kind` enum if absent (additive).

- **Promotion is ONE atomic command batch** (`demand.agreed` + `item.created`(s)), like `createDecision`'s
  decision.created+blocker batch — no window where a demand is agreed without its item(s).
- **Contract bumps:** INGEST 1.2.0→1.3.0; READ 1.11.0→1.12.0 (both additive/minor).
- Legality (transitions) checked AT APPEND in the facade; fold stays pure last-writer-wins. Add
  `State.demands: Map<DemandId,DemandState>`.

## Handler logging ("qui traite") — ratified
A dedicated `handler: ActorId` on every lifecycle transition payload (the h2a instance id, e.g.
`claude:track:238a89077319`) — NOT `prov.by`/`principal` (the channel relays for N agents = confused-deputy).
Three distinct identities kept separate: **source** (who raised, immutable on `demand.raised`) ≠ **handler** (who
processes) ≠ **channel principal** (`prov.principal`, who relayed). Resolution precedence:
`handler = ctx.handler ?? activeLease.holder ?? ctx.prov.principal ?? ctx.by`. The EXPLICIT `ctx.handler`
outranks the live-lease holder — a HANDOVER records whoever ACTUALLY performed the action, not the prior
claimant (else the action would be mis-attributed to a stale lease holder until TTL expiry). The lease holder is
the advisory DEFAULT when no explicit handler is supplied (consistent with the lease being advisory, never
authoritative). Recorded handler-per-step = folded from events. *(Corrected 2026-06-21: the earlier
lease-first formula was a doc typo; pair-review confirmed explicit-first is the correct, shipped behavior.)*

## Lease — ephemeral (ratified)
A mutable side-store `.track/leases.json` (gitignored, NOT the append-only log — heartbeats must not be events),
its own file-lock (reuse `withFileLock`). One active lease per subject. PURE/clockless abandonment computed by the
reader (caller injects `now`): `abandoned ⇔ now − heartbeatAt > ttlMs`. Advisory (never gates an append). track
OWNS the lease READ surface; h2a (or any actor) may PRODUCE claims/heartbeats.
```ts
interface Lease { leaseId; workspace; subject:{kind:'demand'|'item';id}; phase:'qualifying'|'specifying'|'executing';
  holder:ActorId; acquiredAt; heartbeatAt; expiresAt; ttlMs; token; eventHeadAtAcquire?:Sha256 }
```

## F1 (ratified — synthesis): abandonment
- **Explicit abandon** (a handler declares it) ⇒ a DURABLE `spec.abandoned{handler,reason}` fact (who/when/why).
- **Silent timeout** (the agent dies, no declaration) ⇒ EPHEMERAL: the lease expires → the subject is
  re-claimable, surfaced as stalled; NO durable fact (no death-to-compensate). The demand/item is never lost.

## F2 (ratified — synthesis): semantic-race guard, IN this lot but SCOPED
The lock serializes stream integrity, not domain freshness — two actors can fold the same pre-lock state and
append contradictory-but-valid events (esp. the cross-demand DEDUP race the per-subject lease does NOT cover).
Add an under-lock domain-legality recheck **scoped to the NEW Mode A commands only** (via the existing
under-lock hook in `appendCommand`, like the `dedupe` hook): re-fold under the lock + re-assert the demand
transition + the duplicate-target constraint before framing. Do NOT touch existing append paths
(decision.outcome etc.) — the GLOBAL recheck is a deferred follow-on.

## Dedup (at qualifying)
A recorded qualification outcome, not magic: `demand.disposition{outcome:'duplicate', duplicateOf:{kind,id}}`.
The qualifier finds candidates via the `demands()` read + item maps + optional `sourceKey` exact match; track
records the decision, never auto-dedups. Same-workspace + non-self containment asserted at append.

## Reads (additive, pure/clockless) — READ 1.12.0
- `TrackReader.demands(workspace, {now, leases?}): DemandView[]` — status, type, raw/source, itemIds,
  disposition, `lastHandler`, `currentHandler` (live lease), `leaseState:'none'|'live'|'abandoned'`, affordances.
- `TrackReader.lifecycleTrace({kind:'demand'|'item', id}): LifecycleStep[]` — ordered, prov-tagged + handler-tagged
  projection (the demand sibling of `amendmentTrace`).
- Extend `workspaceActivity`: additive `demands` counters + new `StalledReason`s `demand-unqualified-idle` /
  `spec-abandoned-idle` (abandoned lease + idle), reusing the existing stalled machinery (do NOT overload `pending`).
- `canevas`: surface demands + demand affordances (`raised→[claim]`, `qualifying→[agree,disposition]`,
  `parked→[claim]`, terminal→[]).

## v1 scope (smallest additive shippable)
demand aggregate + the 6 events + atomic promotion + `demandId`/`type`/`concerns` back-links + handler field +
ephemeral lease side-store + `demands()`/`lifecycleTrace()` reads + the SCOPED under-lock recheck + the additive
workspaceActivity counters/stalled reasons + `defect` kind. INGEST 1.3.0 / READ 1.12.0.

## Deferred follow-ons
Global semantic-race recheck (decision.outcome etc.); fuzzy auto-dedup suggestions; a background sweeper that
writes `spec.abandoned`; CLI/MCP surfaces (`track demand …`, read-only `track_demands`); cross-host leases;
hard spec-before-realize enforcement in legacy `Track` methods.

## Owner micro-decisions (ratified)
- `demand.raise` = unauthenticated/free (the "nothing untracked" guarantee); claim/agree/disposition/promote =
  binding (auth ∈ {local-user, signed}).
- parked is re-entrant; rejected/duplicate are terminal (a NEW demand may reference them); lease TTL default = TBD
  at build (propose 30 min, owner-tunable).
