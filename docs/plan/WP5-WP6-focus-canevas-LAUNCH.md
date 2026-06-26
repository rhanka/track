# WP5/WP6 Launch — Focus / Decision Dossier / Canevas

> Date: 2026-06-26
> Status: launched / in-progress
> Scope: WP5 Decision Support + WP6 Surfacing / Embeddable Views

## Operator summary

Focus / Decision Dossier is not a single missing feature. It is a stack:

| Layer | Track item | State | Meaning |
|---|---|---:|---|
| Read-only CLI render | `01KVTYRVQ7Z47XR08ZKTYK3D5C` | done | `track focus <decision-id>` renders a decision dossier via `@sentropic/focus` |
| Track-side dossier/canevas reads | `01KTT0VJYKGTFCFE5PRR5MJ1SX` | done | `canevas`, `amendmentTrace`, read contract surfaces exist |
| Embeddable report/dossier views | `01KTKWR6V03FFTJA3SB3JKYF30` | in-progress | host-visible dossier/canevas UI remains to ship |
| Host integration | `01KV4CJJXHZD834QJ68P35WYD0` | in-progress | read polling + submit channel contract remains to bind with host |
| Focus L4 write coordination | `01KVTYRXJQQNNBW8BJJSNQJGTH` | in-progress | action buttons/write path for outcome/spec-amend remain to co-design/ship |

## Product posture

Default Track behavior must be directive, not passive:

- show what is fait / à faire by WP;
- recommend next actions;
- identify execution mode (`local`, `subagent`, `remote`, `h2a`, `human decision`);
- continue reversible work until actions are exhausted or a required decision is unavoidable.

Focus/Canevas is the concrete WP5/WP6 user-facing expression of that posture.

## Fait

- `track focus` exists as a Track command.
- It renders terminal/md/html decision dossiers through `@sentropic/focus@0.3.0`.
- It is read-only and tested (`src/cli/focus.test.ts`).
- `@sentropic/track/read` exposes decision dossier / canevas read types and helpers.
- `@sentropic/track/ingest` already exposes the in-process submit seam needed by a co-located host:
  - `ingest(context, event, store)`
  - `IngestContext`
  - `WorkEvent`
  - `BINDING_AUTH` / `isBindingAuth`
- The ingest contract already treats `decision.outcome`, `spec-amend`, `add-artifact`, evidence, realization,
  blocker resolution, etc. as binding writes that require authenticated context (`local-user` or `signed`).

## A faire — recommended execution queue

### Lot 1 — Focus L4 write contract (Track-side, local)

Define and publish the action-to-WorkEvent mapping for Focus L4:

| Focus action | Track WorkEvent kind | Binding auth | Aggregate |
|---|---|---:|---|
| `ratifyOutcome(decisionId,outcome)` | `decision.outcome` | yes | decision |
| `amendSpec(itemId,patch/summary)` | `spec.amend` / `item.spec-amend` as currently named in Track | yes | item |
| `addDossierArtifact(decisionId,artifact)` | `decision.artifact-added` / `add-artifact` as currently named in Track | yes | decision |

Contract fields:

- `workspace`
- `aggregateId`
- `actor` from `IngestContext`, not event payload
- `prov.auth`: `local-user` for CLI/co-located host v1, `signed` later
- `prov.proposed`: true for machine proposal, false for human acceptance/ratification
- `clientToken` for idempotency
- `baselineCommit` / freshness anchor where applicable
- error semantics: unauthenticated binding write fails; wrong workspace fails; duplicate clientToken returns original receipt

Deliverable: a versioned doc and/or exported helper types that a Focus host can bind without parsing CLI prose.

### Lot 2 — Canevas host integration contract (Track + host/h2a)

Host reads:

- `reader.canevas(workspace,{baselineCommit,decisionId?})`
- `reader.cursor()`
- `reader.amendmentTrace(aggregateId)`
- `reader.acceptanceDetail(...)` where needed for evidence/readiness

Host writes:

- in-process v1: `@sentropic/track/ingest`
- HTTP/M3 remains deferred
- h2a Objective Loop may route/resume cross-agent work, but Track remains repo-local authority for state/evidence

Deliverable: explicit host contract table and a small fixture/test proving a proposed action maps to a WorkEvent.

### Lot 3 — UI/canevas surfacing

Embeddable views must show:

- decision dossier;
- amendment trace with human/machine provenance;
- legal next actions;
- recommended next action / execution mode;
- blocking decisions only when unavoidable.

This is WP6 host/UI work. Track must expose the data/action contract; the host owns rendering shell.

## Decisions

No blocking irreversible decision for Lot 1:

- v1 remains in-process library import via `@sentropic/track/ingest`.
- M3 HTTP gateway remains deferred.
- local CLI/co-located host auth = `local-user`.

Potential later decision:

- whether `track focus` should switch from focus's bundled reader to local `TrackReader` +
  `toDecisionDossierDocument(...)` once dossier fields exceed focus's pinned reader. Not blocking L4 contract.

## H2A Objective Loop alignment

- H2A owns cross-repo/cross-agent objective continuity and relaunch.
- Track owns repo-local references, evidence, WP/decision rollups, and binding writes.
- The Objective Loop should carry structured Track refs (`trackObjectiveRef`) to one or more Track aggregates.
- Focus/Canevas should expose recommended next actions to H2A without pretending machine suggestions are human decisions.

## Immediate next action

Implement Lot 1 as a Track-side contract artifact:

1. inspect current WorkEvent names for outcome/spec-amend/artifact;
2. add a small exported mapping/helper or doc-backed fixture;
3. test authenticated vs unauthenticated binding behavior through `@sentropic/track/ingest`;
4. report back with a WP5/WP6 table: Fait / A faire / Prochaine action / Decision.
