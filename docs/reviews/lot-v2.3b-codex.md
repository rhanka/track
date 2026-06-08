# Lot v2.3b DESIGN (M2b write seam) — Codex (gpt-5.5 xhigh) review

Pre-code design review of `docs/plan/v2.3b-DESIGN.md` (channel ① ingest contract + pure mapping).
Paired with `docs/reviews/lot-v2.3b-opus.md`. **Verdict: revise** — channel ① is the right M2b
direction; one security-grade gap + sharpenings. All applied in the design revision.

## Findings (applied)
- **Workspace pin is illusory for existing-aggregate commands (security-grade, the headline).**
  `payload.workspace !== ctx.workspace` only protects creates; all other kinds address a pre-existing
  aggregate by id with no workspace payload, so the check is a no-op and a W-pinned channel can settle
  state in another workspace V. **Single most important change:** a stateful `authorizeWorkEvent(ev, ctx,
  state)` that folds state, derives every affected aggregate's workspace, rejects cross-workspace
  references/effects, and treats `payload.workspace` as valid only for newly-created aggregates.
  (`setOutcome` emits blocker resolutions + target `realization.transition` in one batch — verify each.)
- **Binding table:** `cancelled` is also binding (drops the item per report semantics); manual
  `blocker.resolve` is binding. `acceptance.run` is **evidence, not human judgment** — forbidden on
  unauthenticated, allowed local/`signed`. Keep `accept run --from` (report parse + dedup) as the shipped
  CLI verb; `acceptance.run` WorkEvent → `recordRun` only (the 1:1 atomic primitive).
- **v1 must REJECT unknown payload fields** (fail-closed), not silently ignore; add explicit per-kind
  payload schemas.
- **`track ingest`** is sound and NOT a new transport (same shape as `accept run --from` / `branch
  import`); make `--workspace` required; ingest only normalized WorkEvent JSONL (no report/BRANCH parse).
- **Parity** must cover multi-event `cmdId` batches (`createDecision`, no-go), generated aggregate/payload
  ids; dossier/sourceKey fields need golden tests or v1 exclusion.
- **Reserved slots:** reserve concepts, not accepted fields — `sponsor?` must not appear in the exported
  v1 interface; `dossier.artifacts[]` shape non-normative until M5.
- **M3-ready** after the workspace fix (request-derived `IngestContext`, additive `Provenance` widening to
  `signed`/principal). **Scope:** move stateful workspace authorization + explicit payload schemas +
  required CLI workspace + corrected binding table IN; keep `ingestRuns` report path OUT of the contract.
