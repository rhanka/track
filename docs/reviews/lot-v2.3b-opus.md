# Lot v2.3b DESIGN (M2b write seam) — Opus 4.8 review

Pre-code design review of `docs/plan/v2.3b-DESIGN.md`, paired with `docs/reviews/lot-v2.3b-codex.md`.
**Verdict: revise** (architecture sound; one security-critical gap + sharpenings). Strongly convergent
with Codex. All applied.

## Findings (applied)
- **The workspace pin is illusory for every existing-aggregate command (the leak is real).** `workspace`
  is a payload field on **only** `item.create` and `decision.create`; all other kinds address an aggregate
  by id with no workspace. So a channel pinned to W can pass `decision.outcome <id-in-V>`,
  `acceptance.waive <criterion-in-V>`, `item.realize <id-in-V> done`, `priority.assess <id-in-V>` — **3 of
  the 4 binding kinds are exactly the ones with no payload workspace.** Fix (single most important change):
  `ingest` FOLDS `Track.state()` and verifies the **resolved target aggregate's** `workspace ==
  ctx.workspace` for every kind (resolver: id→item/decision; blocker→target→item; criterion→item;
  evidence→criterion→item); re-fold after each sequential apply so batch-chained new ids resolve. This is
  also what keeps an M3 verified principal from crossing workspaces.
- **Binding-trust rule is fail-open** as phrased (`auth !== 'unauthenticated'` admits every future enum
  value). Make it an **allowlist**: `auth ∈ {'local-user','signed'}`.
- **`acceptance.run` miscategorized + breaks 1:1.** It is machine evidence, not judgment; its dual
  `recordRun`/`ingestRuns` mapping is one-kind-two-methods, and `ingestRuns` fans out by locator across
  **all** evidence regardless of workspace (a second cross-workspace leak). **Map `acceptance.run` →
  `recordRun` only; keep `ingestRuns`/`accept run --from` as the shipped CLI verb, out of the contract.**
  (`item.realize→rejected` is unreachable via ingest — covered transitively by `decision.outcome`.)
- **Idempotency under-specified.** The shipped ingests are idempotent; the neutral `WorkEvent` ingest is
  not (re-running double-applies). Take a documented stance (at-least-once + caller dedups; reserve an
  optional `clientToken`).
- **Anti-drift:** `mapWorkEvent` and the CLI `oneOf`/`req` are two parallel validators kept in sync only
  by whichever parity cases run. **Factor one shared per-kind schema table both consume** — structurally
  nothing to drift.
- **Parity must be integration-level over a fixed seed log** (state-dependent batches like `setOutcome`;
  `cmdId`/`cmd` batch equality; assigned-id returns) — not a pure `{method,args}` comparison.
- **`sponsor` reserved in the wrong place:** as a top-level envelope field it travels per-event = the
  confused-deputy shape §2 forbids. If D6-B is adopted, reserve it as a **decision payload** field.
  `Dossier.artifacts[]` is a clean additive reserve.
- **M3 readiness:** clean once the workspace fold-check is in `ingest` (HTTP inherits it); binding gate
  reads `ctx.prov.auth` (allowlist) so flipping to `'signed'` is code-free; `Provenance` widens additively
  (`signed` + `sig`/`principal`, new HTTP transport). Scope OUT list correct; move target-workspace
  verification IN; keep `ingestRuns` report-batch OUT of the contract.
