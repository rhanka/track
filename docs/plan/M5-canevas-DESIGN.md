# M5 — CANEVAS views (track ↔ sentropic host) — design

**Date:** 2026-06-10 · **Status:** owner-approved (Q2 ok), build-ready · **Double-reviewed by the Codex 5.5xhigh
+ Opus 4.8max PAIR (converged).** Supersedes the wrong "WP6 DS-owned" framing (corrected
`workpackages-DESIGN.md`).

## 0. Frame (owner-corrected)
M5 = two **canevas** (editable, live, bidirectional) embedded in **sentropic** (the host; the conductor /
architect decides the internal placement — chat-ui / LiveDocument is the likely surface): (1) the `report`
view (kanban→canevas: the AI pushes updates AND the human creates actions *via the view*), (2) the
decision-dossier view (decision validation + **live spec amendment with a human/machine diff trace**).
**Not DS-owned** (DS = skins/themes only). track = the heavy half. mermaid-editor/diag = annotation/cerclage.

## 1. Prime-directive reconciliation — "live" is NOT a track socket
track stays record-only / append-only / no-clock / no-server. Liveness decomposes:
- **live-out (track→view):** the **host** drives it. track exposes a *materialization read* + a *cheap change
  cursor* (the log head hash). The host polls/watches `cursor` (it owns a clock + fs/git watcher) and re-reads
  on change. Same shape as the shipped `workspaceActivity` (caller injects `now`).
- **live-in (view→track):** a human/AI canevas action = **one WorkEvent** through the shipped `ingest()` seam,
  `prov.proposed:false`=human / `true`=AI. **The human/machine diff trace is free** — a pure projection over
  `prov`, zero new event data.

## 2. Track's half — 3 additive reads + the shipped ingest seam
- **`canevas(workspace,{baselineCommit, decisionId?})`** — the materialized report+WP rollup (and the full
  decision dossier) joined with per-aggregate `prov` lineage + open-action affordances. Pure.
- **`cursor()` / `changesSince(cursor)`** — `{head: contentHash, count}` from the log tail (O(tail)); the
  host's liveness primitive.
- **`amendmentTrace(itemId|decisionId)`** — ordered prov-tagged projection over `spec.amended`,
  `decision.dossier`, `decision.add-artifact`, `decision.outcome` = the human/machine diff. Pure.
- Three read MCP tools (`track_canevas`/`track_cursor`/`track_amendment_trace`), CLI≡MCP parity. MCP stays
  read-only; streaming/live delivery is the host's runtime. `READ_CONTRACT_VERSION` minor bump.

## 3. Action model (additive) — Q2 RESOLVED
Every canevas action maps to an existing WorkEvent: create→`item.create`, move→`item.reparent`,
status→`item.realize`/`item.spec`, blockers→`blocker.*`, acceptance→`acceptance.*`, priority→`priority.assess`,
decision validation→`decision.outcome`, evidence→`decision.add-artifact`. **One net-new additive kind
(owner-approved):**
```ts
kind: 'item.spec-amend'  → persisted event 'spec.amended'   // append-only, on the existing item aggregate
payload: { itemId, decisionId?, liveDocRef?, baseHash, patch: JsonPatch, resultHash, proposalRef?, summary? }
```
A JsonPatch over the track spec document with `baseHash`/`resultHash` (concurrent-safe; `decision.dossier`'s
whole-`Dossier` rewrite is a lost-update hazard — the live amendment primitive is `item.spec-amend`, the
dossier stays a coarse checkpoint). Binding-gated, `clientToken` idempotent. AI proposes (`proposed:true`,
`proposalRef`); a human/signed amendment referencing `proposalRef` records acceptance — **never launder the
machine origin away**.

## 4. Reversibility + boundary
Reversibility = **compensating events only** (append-only): an inverse `item.spec-amend` / a correcting
WorkEvent; a terminal `decision.outcome` is corrected by a follow-up decision, never mutated. Boundary: render
+ live loop + optimistic UI = host; annotation/cerclage = mermaid-editor; skins = DS; presentation logic/risk =
h2a. **D5 = the track↔host canevas-module negotiation, NOT a DS decision.**

## 5. Track-side deliverable (additive, TDD, OIDC)
The 3 reads + `item.spec-amend`/`spec.amended` (type+fold+ingest schema+facade+binding-gate+clientToken+prov
tests) + the `amendmentTrace` projection. Reuses the shipped `ingest()` for all writes. Co-designed cross-repo
(D5, with the host): the sentropic canevas component (render `canevas`, watch `cursor`, render
`amendmentTrace`, submit edits as WorkEvents via an authenticated channel) + cerclage reuse.
