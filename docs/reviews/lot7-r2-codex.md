**Findings**

- **BLOCKER** [src/cli/index.ts](/home/antoinefa/src/track/src/cli/index.ts:61), [src/state/fold.ts](/home/antoinefa/src/track/src/state/fold.ts:263): CLI accepts `--rule linked-accepted`, but fold only auto-resolves `linked-done`; manual resolve also rejects non-`manual` blockers. Built CLI probe: ref item reached `acceptance:"pass"`, target stayed `AWAITED`. Fix: for MVP, reject/remove `linked-accepted` from CLI/facade/docs per SPEC §10, or implement real linked-accepted auto-resolution coherently.

- **MINOR** [src/cli/index.ts](/home/antoinefa/src/track/src/cli/index.ts:66), [src/report/build.ts](/home/antoinefa/src/track/src/report/build.ts:99): `query --acceptance n/a` is accepted but query projects non-decision rows only, so it silently returns `[]`. Fix: remove `n/a` from query acceptance validation and narrow the query filter type.

**Confirmed**

Round-1 fixes otherwise landed: enum probes now exit 1, `--workspace` is required, `--from` requires `junit|json`, desync flags missing/no-H1/H1 mismatch and skips multiline inline bodies, dossier context merges, manual decision blocker raise works. `src/events/*` unchanged.

Checks: `npm run typecheck` passed. `npm test` direct hit read-only Vite temp write, but `TMPDIR=/var/tmp npx vitest run --configLoader runner` passed: 140/140. Worktree clean.

**VERDICT: CHANGES-REQUIRED**