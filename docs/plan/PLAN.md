# PLAN — `@sentropic/track` MVP

> Implements `docs/spec/SPEC.md`. Strategy: **single-writer append-only core first, TDD throughout** (tests map to SPEC §8 A1–A7). Each lot ships tests-green and is independently reviewable. No external backend, no MCP, no h2a calls (all v2+). Concurrent multi-writer merge is **v2+**.

## Goal — Milestone 1

> *"existing `BRANCH.md` → track sidecar (read-only) → `track report` renders done/to-do/awaited/dropped, via the CLI."*

Milestone 1 = **Lots 0–6 reached, including the minimal CLI wiring** for `track branch import` and `track report` (so SPEC A1/A2 are genuine CLI acceptance tests). The full CLI surface (all verbs) is Lot 7.
**Flagged scope cut (vs INTENTION):** Milestone 1 makes track *readable* (exposes `report`/`query` JSON) but does **not** wire `scope-check`/`lot-gate` to *consume* track — that consumption is **v1.1**. Stated here, not silent.

## Stack (decided here, reversible)

TypeScript (ESM), Node ≥ 20, `vitest`, `tsx` CLI entry, minimal deps (ULID + arg parser). npm scripts: `build`, `test`, `lint`, `typecheck`. Package `@sentropic/track`, bin `track`, `private:true` until a publish decision.

## Lots (ordered; each gate passes before the next)

### Lot 0 — Scaffold
- **Deliver:** `package.json` (bin `track`), `tsconfig`, vitest, scripts, CI lane (typecheck+test), module layout (`model/ events/ state/ accept/ priority/ report/ branch/ cli/`).
- **Gate:** `build && test` green on a placeholder.

### Lot 1 — Event core (single-writer) + fold + integrity
- **Deliver:** the `Event` frame (SPEC §3: `id,type,aggregate,aggregateId,seq,prevHash,cmdId?,at,by,payload,contentHash`); append-only store (`.track/events.jsonl`); `contentHash=sha256(canonicalJSON(payload))` (payload only); positional chain (`prevHash` + per-aggregate `seq`); `fold(events)→State`; rebuildable snapshots; **atomic command batch** (`cmdId`, all-or-nothing append); `validate` integrity (tamper + reorder + seq).
- **Tests:** append→read round-trip; **A4** (payload-hash tamper *and* prevHash/seq break detected); **fold determinism by single-stream replay**; partial-batch (`cmdId`) detection. *(No concurrent-merge test — v2+.)*
- **Gate:** integrity + fold + batch tests green. **(This is the contract everything folds over — freeze it here.)**

### Lot 2 — Item axes + blockers
- **Deliver:** spec (`to-specify→specified`) & realization (`to-do→in-progress→done|cancelled|rejected`) transition guards (illegal rejected pre-append); blockers as `opened/resolved` events + computed open set; dependency `resolutionRule` (`linked-done` default, `manual`).
- **Tests:** illegal transitions rejected (**A3** partial); open-blocker set; dependency auto-resolves on linked `done`; manual resolve allowed only for `dependency`.
- **Gate:** green.

### Lot 3 — Decisions (specialized) + outcome machine + dossier + disposition
- **Deliver:** `kind:decision` specialization (spec/accept n/a; criteria forbidden — A3); recursion guard (A3); **`outcome` transition machine** (`pending→go|no-go|deferred`, `deferred→go|no-go`, terminals; supersede via new event); `decision.created`→`blocker.opened` per target (**A7**); target effects as atomic `cmdId` batch (`go`/`no-go`/`deferred` — **A5**); decision-blocker auto-resolve only on `go|no-go` + reject manual resolve (A3); typed `Dossier`; `decision.disposition` (+ auto-`completed` on settle).
- **Tests:** **A5**, **A7**, outcome transition legality (reject out-of-terminal), manual-resolve rejection, atomic batch + partial-batch repair, disposition queryable.
- **Gate:** green.

### Lot 4a — Acceptance
- **Deliver:** criteria/evidence/runs/waivers; the **total** `criterionStatus`/`acceptanceStatus` cascade (SPEC §2.4) incl. `fail`-overrides-`waiver`, multi-evidence aggregation, `stale` vs `baselineCommit`; `accept run --from <junit|json>` ingestion.
- **Tests:** **A6** (fail overrides waiver); stale detection; multi-evidence (all-pass vs one-fail); zero-criteria→`unknown`.
- **Gate:** green.

### Lot 4b — Prioritization (independent of 4a)
- **Deliver:** `PriorityAssessment` (versioned, append-only); live `priority` vs frozen `decisionEvaluation` snapshot; WSJF scheme.
- **Tests:** WSJF score + ordering; frozen snapshot ≠ live priority.
- **Gate:** green.

### Lot 5 — `report` + `query`
- **Deliver:** bucket engine with SPEC §7 precedence (AWAITED>DROPPED>DONE>TO-DO), `kind!=decision` default + `--decisions`, `report.requireAccepted` toggle, sort by active scheme; `query` (kind/workspace/bucket/status); `--format json|text|md`.
- **Tests:** **A2** (four-bucket fixture incl. no-go→DROPPED, in-progress+dependency→AWAITED); precedence edges (done+open-blocker→AWAITED); decision-view.
- **Gate:** green.

### Lot 6 — `BRANCH.md` import/annotate + minimal CLI — **Milestone 1**
- **Deliver:** parser for `BRANCH_TEMPLATE` sections (feature/objective/scope/lots/nested-UAT; gates ignored); derived Items with `id:Ulid` + stable `sourceKey=<branchSlug>/<lotSlug>` (slug, not index); idempotent re-import (delta-only, survives reorder); checkbox→state mapping (lot `[x]`→`done`, UAT `[x]`→manual `pass` run); **read-only on BRANCH.md**; **CLI wiring for `track branch import` and `track report`** (so A1/A2 run via CLI).
- **Tests:** **A1** (real BRANCH fixture; BRANCH.md hash unchanged; derived Items; idempotent re-import under reordering); CLI smoke `init → branch import → report`.
- **Gate:** **A1** + CLI smoke green → **Milestone 1 reached**.

### Lot 7 — Full CLI surface + docs
- **Deliver:** remaining CLI verbs (SPEC §6) over the core; `validate` wired (integrity + desync rule §4); README usage.
- **Gate:** end-to-end CLI test across the verb set green.

## Dependency order
`0 → 1 → 2 → 3 → {4a, 4b} → 5 → 6 → 7`. Lot 1's event/fold/batch contract is the freeze point; 4a/4b are independent and parallelizable behind their own gates; Lot 6 depends on 1–5; Lot 7 wraps all.

## Test strategy
Unit per lot. Integration: a golden `.track/events.jsonl` exercising the full lifecycle (create → orientation decision → go → specified → in-progress → acceptance runs → done; plus a parallel no-go path → DROPPED), asserting **fold determinism on single-stream replay**. E2E: CLI smoke (Lot 6/7). Acceptance A1–A7 are the Milestone-1 merge gate.

## Risks
- **BRANCH.md parsing brittleness** — parse only stable `BRANCH_TEMPLATE` sections; tolerate unknown sections; never fail import on extra prose.
- **Prose↔log desync** — `validate` flags (file exists + H1 matches title); no auto-repair (deferred).
- **Scope creep toward h2a/MCP/concurrency** — any h2a call, MCP, or multi-writer merge is out of MVP.

## Out of scope (v2+)
Per `INTENTION.md` + SPEC §9: external backends, MCP, multi-host plugins, llm-mesh, consolidation, concurrent multi-writer merge, UI, binding decisions via h2a, scheme registry beyond WSJF, skills *consuming* track (v1.1).
