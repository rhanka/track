# @sentropic/track

Typed product-backlog and **spec / plan / UAT tracking** for the sentropic ecosystem.

**Record-only** — track is the *system of record*; it reuses **h2a** for identity, the signed append-only journal, blockers, and (optional) multi-agent coordination. Standalone `track` CLI first; registered as `stp track` later.

> Status: **intention committed; SPEC + PLAN in progress.** See [`INTENTION.md`](./INTENTION.md), the model reviews in [`docs/reviews/`](./docs/reviews), and [`docs/spec`](./docs/spec) / [`docs/plan`](./docs/plan).

## Model (one line)

An `Item` carries three orthogonal axes — **specification** (`to-specify → specified`), **realization** (`to-do → in-progress → done | cancelled | rejected`), **acceptance** (computed `pass/fail/unknown/stale/waived`) — plus **blockers** (relations) and **prioritization** (versioned, optional, e.g. WSJF). **Decisions** (orientation studies, go/no-go commitments) are first-class linked items. `report` projects done / to-do / awaited / dropped.

## MVP scope

`docs-git` backend · typed schema · append-only event log · `validate` / `query` / `report` · `BRANCH.md` import + annotate (**BRANCH.md stays the source of truth**) · single host via CLI.

**Out of MVP (v2+):** external backends (Jira/GitHub/VersionOne/Azure) · MCP server · multi-host plugins · llm-mesh / multi-repo consolidation · UI screens · binding decisions via h2a negotiation.

See [`INTENTION.md`](./INTENTION.md) for the full model, boundaries, and rationale.
