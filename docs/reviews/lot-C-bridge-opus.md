# Lot C (h2a-bridge read surface) — Opus 4.8 review

Final lot of `M3-deps-raci-DESIGN.md`, paired with `docs/reviews/lot-C-bridge-codex.md`. **Verdict:
ship-with-changes** → applied.

## Confirmed (ground-truth checked)
- **`externalDependencies()` correct:** `isOpen` returns false only on `resolvedByEvent`; an extra dep
  (`ref===undefined`) skips the linked-done branch and stays open until resolved — exactly the watch window.
  Excludes resolved-extra / intra / decision blockers. Baseline-free (an extra dep is settle-once; openness
  never depends on `baselineCommit`).
- **Read-contract additive (1.1.0); MCP tool side-effect-free + parity.** No read-only-contract break.
- **Bridge pattern** find-then-resolve-by-blockerId is clean and correct for the shipped surface.

## Findings → resolution
- **Doc/impl mismatch (both reviewers):** the doc said the resolve "carries the engagementRef" but the
  WorkEvent is `{blockerId}`. **Resolved two ways:** (1) the doc now states the bridge resolves by blockerId
  found via `externalDependencies()`; (2) the emitted `blocker.resolved` **event** now records
  `engagementRef` (stamped server-side from the blocker — additive, hash-safe), closing the audit gap (an
  auditor ties a resolution to its engagement without re-folding). A bulk resolve-by-engagementRef (one
  engagement → N items) is a deferred write-path feature; the fan-out test documents the N-resolve pattern.
- **Single most important fix (Opus #1) — APPLIED:** cross-workspace containment on the **signed**
  `blocker.resolve` — the load-bearing security property for the automated path. Test: a `bridge` pinned to
  W is rejected resolving an extra dep whose target is in V (`belongs to workspace "V"`). + the MCP-dispatch
  test + the two-deps-one-engagement test.
- **Deferred (tracked, non-blocking):** bulk resolve-by-engagementRef; the bridge's double-resolve is a hard
  error, not an idempotent no-op — a tokened resolve (`clientToken`) is already idempotent (the shipped
  delivery-idempotency dedups the re-applied resolve), so an automated bridge should carry a token.

## Plan completion
Substantively COMPLETE: Lots A (model + write seam), B (signed channel), C (read surface + bridge) are
present and mutually consistent; the end-to-end automated path (open → watch → signed resolve → unblock) is
demonstrable; frozen event contract untouched (additive only).

## Outcome
309 tests green; frozen-contract neutral. Ships as 0.7.0.
