# Lot 7 Confirmation Review — `@sentropic/track` MVP — Opus 4.8

**Gate:** typecheck clean; `npm test` 140/140; `src/events/*` unchanged. Built CLI probed in temp dirs.

## Round-1 (Codex) fixes — all verified correct
1. **Enum validation** via `oneOf()` on every mutating/filtering verb — invalid input exits 1 (`item new --kind bogus`, `query --bucket NOPE`, `accept run --result maybe`, `accept link --kind bogus`, `accept run --from f.json --format junk`). No casted input persists garbage or returns silent-empty.
2. **`--workspace` required** for item/decision new (silent default removed).
3. **desync** flags missing file, no-H1, and H1≠title; multi-line inline bodies skipped (`^[^\n]+\.md$`).
4. **`decision dossier --context` merges** (options/qa preserved).
5. **`openBlocker` decision ref** resolves against `state.decisions`.

Enum lists cross-checked exact vs `model/*`. Error/exit codes consistent (DomainError→1, unknown→2). README accurate.

## Overall MVP
The §6 CLI surface is complete and coherent end-to-end over the Lots 1–6 model; frozen contract untouched; 140 tests green. Nothing blocks declaring the MVP done.

**VERDICT: SHIP**

---
_Note: Codex's parallel round-2 caught two semantic gaps this type-focused pass missed — `--rule linked-accepted` is offered but unimplemented (SPEC §10 defers it → stuck blocker), and `query --acceptance n/a` is unreachable. Both fixed (linked-accepted dropped from the MVP surface; n/a dropped from query). See lot7-r2-codex.md._
