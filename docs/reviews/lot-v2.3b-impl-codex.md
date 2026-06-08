# Lot v2.3b IMPLEMENTATION (M2b write seam) — Codex (gpt-5.5 xhigh) review

Lot-1-grade review of the `WorkEvent` ingest implementation (`src/ingest/{contract,map,ingest}.ts` +
`track ingest`). Paired with `docs/reviews/lot-v2.3b-impl-opus.md`. **Verdict: block → one-line fix →
ship.** Both reviewers independently found the SAME P0 and prescribed the SAME fix.

## P0 — workspace containment bypass via `item.realize` on a decision id (FIXED)
`resolveWorkspace` authorized `item.realize` only against `state.items`, but `Track.setRealization`
intentionally mutates a **decision** when the id is a decision id (`track.ts:133-148`). A decision id
resolved to `undefined` → the containment guard was skipped → Track wrote. A W-pinned channel could thus
realize a V **decision** by `{kind:'item.realize', payload:{itemId:<V decision>, to:'in-progress'}}` —
and `in-progress` is non-binding, so even an **unauthenticated** channel could do it. **Fix:**
`resolveWorkspace` for `item.realize` resolves `items ∪ decisions`
(`state.items.get(id)?.workspace ?? state.decisions.get(id)?.workspace`). Regression test added (incl. the
unauthenticated non-binding case). `setRealization` is the **only** facade method whose resolution domain
is broader than `resolveWorkspace`'s — every other kind resolves a single aggregate domain and matches.

## Confirmed sound
- **Containment, all other kinds:** `decision.outcome` checks the decision's workspace + all folded
  targets (so a historical W-decision targeting a V-item is rejected); acceptance chains resolve
  evidence→criterion→item correctly; unknown ids safely throw in Track; `blocker.raise` doesn't mutate
  `ref` (only `targetId`, checked). Re-fold per event confirmed.
- **Binding gate:** classification matches design; `Set<string>` pre-admitting `'signed'` sound as a
  channel-trust allowlist (callers must not lie when constructing `IngestContext`).
- **Mapper args:** match the facade + CLI for all tricky cases (blocker reason default `''`, disposition
  reason passthrough, recordRun object, WSJF inputs); unknown envelope + payload fields fail closed.
- **CLI verb:** `transport:'import'` (not `writeTrack`'s `'cli'`), `--workspace` required, JSONL parsed
  fail-closed; errors → exit 1, missing file → exit 2.
- **Frozen contract:** WorkEvent is `{v,kind,payload}` only; prov remains the event carrier; removing
  envelope `proposed` is the right refinement.

## Non-blocking (addressed / noted)
- **Parity coverage broadened** (was: go-outcome + 12 kinds): added `acceptance.waive`,
  `decision.disposition`, terminal `item.realize`, and a `no-go` (rejected) batch.
- **At-least-once is a real CI-retry footgun** — duplicate creates on re-ingest (test confirms). Now
  flagged loudly; do NOT carry into an M3 automated-retry path without idempotency.
- Minor (left as noted): `dossier` validated as opaque object only; `blocker.owner` exposed without a CLI
  flag (harmless additive superset).

## Outcome
262 tests green; typecheck + build clean. Ships as 0.3.0.
