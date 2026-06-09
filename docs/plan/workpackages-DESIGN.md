# Workpackages — perennial structure + representation (design)

**Date:** 2026-06-09 · **Status:** decided (owner-ratified 6-WP cut + representation) · **Double-reviewed by
the Codex 5.5xhigh + Opus 4.8max PAIR (converged)** — for the structure and for the representation. Grounded
in a 3-agent Sonnet scan of ~158 fleet repos (gold precedent: `~/src/agent-stats/plan.md`
`WP-N (X/Y,Z%) → Lot N.M → task`).

## 0. Decisions (ratified)
- Structure track's work as **6 perennial WORKPACKAGES** (term: *workpackage / WP*, NOT "theme").
- Concrete deliverables are **sub-WPs** (`WP1.1`); atomic todos are leaves: **`WP1 → WP1.1 → todo`**.
- Represent a WP with an additive **`role:"workpackage"`** field on a parent `Item` — no new kind, no
  convention, no sourceKey-as-marker.
- Organize the existing flat backlog with an additive **`item.reparent`** event.
- `%` is **rolled up from leaf buckets** (done/active), never manually asserted.

## 1. The 6 perennial workpackages
| WP | Charter | Boundary (NOT here) |
|---|---|---|
| **WP1 · Record Integrity & Contract** | the append-only log never lies — frozen chain, additive evolution, idempotency, the read/ingest contract versions, **the P0 write guard** | not the write *transports* (WP3); not the render (WP6) |
| **WP2 · Reporting & Conductor Pilotage** | turn the record into decision/action aids — buckets, **%-by-WP rollup**, the fait/à-faire/attendus view, the propose-workpackages skill | not the DS render (WP6); not write authority (WP4) |
| **WP3 · Write Surfaces & Ingest** | every authenticated way bytes enter — CLI, the `WorkEvent` ingest seam, MCP, the signed HTTP channel, `branch import` | not the chain rules (WP1); not who-may-write policy (WP4) |
| **WP4 · Multi-Agent Coordination (h2a / worktrees / RACI)** | track-as-record in a multi-agent, multi-worktree fabric — engagement refs, RACI, who-may-update, the `workspaceActivity` signal, stable worktree-id, the h2a bridge | track never coordinates/decides/schedules; contract body stays in h2a |
| **WP5 · Decision Support (dossiers / presentation / mockups)** | the record-side of decision aids — `Dossier.artifacts[]`, comprehension evidence, sponsor (D6-B), the decision-presentation skill, **D5 mockup referents** | presentation *logic* = h2a (EVO-9); *render* = DS (WP6). track holds pointers + evidence |
| **WP6 · Surfacing / Embeddable Views (DS-owned)** | the embeddable-view contract that renders track's `report` + the dossier in sentropic (M5) | not track's to define — DS-owned (D5); track states input shapes only |

**D5 recovered (was lost):** D5 = *live design-system mockups as a decision aid* — record-of-decision in
**WP5** (`Dossier.artifacts[] kind:'mockup'`), build dependency in **WP6/DS**. Distinct from M5 (the render
contract, WP6).
**"M5-wiring" renamed** → *"Decision-artifact record contract"* (`Dossier.artifacts[]` + `decision.add-artifact`,
record-only pointer; see `M5-decision-presentation-DESIGN.md`). Lives in **WP5**.

Full item→WP mapping: see the pair specs (archived). Every one of the 26 current items maps to exactly one WP.

## 2. Representation (pair-converged)
A workpackage is an **`Item`** with `kind:'chore'` and the additive marker **`role:'workpackage'`**. WP-ness
comes from `role`, never from `kind`, has-children, a `wp:` sourceKey, or a link.

- **Marker — `role:"workpackage"` (additive optional field).** Rejected: new `kind` (frozen-enum tax for a
  container with no behaviour); convention `chore+children` (a childless WP is mis-counted as a leaf — the
  exact false-% bug `agent-stats` warns about twice); `sourceKey`-as-marker (overloads identity); `links`
  marker (side-channel). `role` is orthogonal/optional like `accountable`/`engagementRef` → **zero hash
  change**, explicit, queryable, rename-stable.
- **Nesting — arbitrary-depth `parentId`.** House style `WP1 → WP1.1 → todo`; the model permits deeper (the
  fleet has 3–4 levels: `Program/Wave → BR → Lot → task`). One new invariant: **a WP nests only under a WP**;
  a leaf may nest under a WP or a leaf (back-compat with `branch import`'s feature→chore).
- **Numbering — `WP1.1` is a DERIVED display label** (walk the `parentId` chain at read time), **never stored
  positional identity**. `id` = identity; `sourceKey` = stable **non-positional** slug (`wp:record-integrity`).
  This dissolves the reparent hazard: the display ordinal renumbers automatically; nothing stored encodes
  position. (A durable public `WP1.1` code, if ever needed, = a later optional `code?` field — deferred.)
- **`%` rollup.** Per WP/sub-WP, over **transitive non-WP leaf descendants**, using `bucketOf`:
  `pct = done / active`, `active = DONE + TO-DO + AWAITED`, DROPPED excluded + shown separately; **parent =
  SUM of descendant leaves, never mean-of-child-percentages** (Simpson trap); **`0/0 ⇒ n/a`**, never 100%.
  Optional `requireAccepted` makes the % acceptance-honest (recommended ON for release-gating WPs). This is
  agent-stats' honest done/total — and it **retires the manual % tables** other `.track` repos hand-maintain.
- **`item.reparent` (additive event).** WorkEvent kind `item.reparent` → persisted **`item.reparented`**
  (follows the `item.created` convention) on the **existing item aggregate** (no recreate; next seq; existing
  hashes untouched). Fold sets/clears `parentId`. Guards: item+parent exist, **same workspace**, no
  self-parent, **no cycles**. **Binding-gated** (`auth ∈ {local-user, signed}` — moving work between WPs is
  trust-sensitive). Containment from folded state for both child and parent.

**Key fact:** track **already ships this hierarchy** — `importBranch` builds `feature → chore → criteria`. We
are not designing a new structure; we are **marking + rolling up** the one that ships.

## 3. Minimal additive surface (the whole diff)
1 field (`role?:'workpackage'` on `ItemState`+`ItemCreatedPayload`) · 1 WorkEvent kind + 1 EventType
(`item.reparent`/`item.reparented`) · 1 fold case + `role` spread in `item.created` · 1 facade command
(`Track.reparentItem`, cycle+WP-under-WP+workspace guards) · ingest: `role` allowed on `item.create` +
`item.reparent` binding kind (parity-gated) · 1 new `report/rollup.ts` (`computeWpTree`) + optional
`wpTree?` on `Report` + `query({role})` filter + a Markdown renderer matching agent-stats' shape. **No change
to any existing event/hash/seq/bucket/query result.** `READ_CONTRACT_VERSION` bumps; ignore-unknown keeps old
logs valid (D7).

## 4. Build order (under WP1/WP2)
1. **P0 write-loss fix** (`P0-write-loss-FIX.md`) — gates trust in every write; **first**.
2. **WP foundation** — `role` field + `item.reparent` + `report/rollup.ts` (this is also `report-revamp`:
   fait/à-faire %·WP/attendus). These interlock → one lot.
3. **Structure the backlog** — create the 6 WP parent items + `reparent` the 26 existing items (needs step 2).
4. **propose-workpackages skill** (WP2) — automate the clustering (heuristic in the pair specs).

## 5. Owner decisions (ratified / defaults)
- `role:"workpackage"` (the word) ✓. No depth cap (only WP-under-WP). `%` default `requireAccepted:false`
  (flag documented). `sourceKey` = non-positional slug; dotted `WP1.1` derived. `code?` durable label —
  deferred. All additive + reversible.
