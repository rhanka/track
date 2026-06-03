**Findings**
- **major** [src/track.ts:186](/home/antoinefa/src/track/src/track.ts:186) — `no-go` accepts terminal targets, resolves their decision blockers, and skips the required `realization.transition -> rejected`. That violates §2.6/A5’s per-target atomic effect and can leave a no-go target `done`/`cancelled` instead of DROPPED. Fix: preflight every target with `assertRealizationTransition(target, 'rejected', true)` and reject the whole command before appending if any target is terminal. Reachability: input-surface via `createDecision` → target reaches `done`/`cancelled` → `setOutcome(d, 'no-go')`.

- **major** [src/track.ts:127](/home/antoinefa/src/track/src/track.ts:127) — duplicate `targets` are accepted. `createDecision` opens duplicate blockers, then `setOutcome` uses `.find(...)` over the pre-batch state at [src/track.ts:175](/home/antoinefa/src/track/src/track.ts:175), so duplicate target entries can resolve the same blocker twice and leave another decision blocker open; `no-go` can also emit duplicate rejection transitions for the same item. Fix: reject duplicate target IDs at `createDecision` or canonicalize to unique targets before storing/emitting. Reachability: input-surface.

**Checked**
- `src/events/*` is unchanged in the Lot 3 diff.
- Gate disposition stream-order LWW looks correct for explicit-then-settle, settle-then-explicit, multiple settling decisions, and deferred-then-go.
- A7 blocker `ref = decisionId` matches `setOutcome` lookup on the normal path.
- A3 foundation for Lot 4 is sound: decisions are in `state.decisions`, not `state.items`, so acceptance can reject decision ids by accepting only non-decision items.

Verification: `npm run typecheck` passed. `npm test` could not run to completion because Vitest tried to write under `node_modules/.vite-temp` and the workspace is read-only.

**VERDICT: CHANGES-REQUIRED**