**Findings**
- **major** [src/track.ts](/home/antoinefa/src/track/src/track.ts:470): Existing UAT criteria short-circuit before checkbox state is considered. A re-import from `[ ] UAT: ...` to `[x] UAT: ...` emits no `acceptance.run`, so `report --require-accepted` can stay `unknown`. Fix: when a matching criterion exists, find/create its branch evidence and append a pass run when `uat.passed` is true and that run is not already current. Reachability: normal BRANCH.md UAT checkbox update after an earlier import.

- **major** [src/branch/parse.ts](/home/antoinefa/src/track/src/branch/parse.ts:32): The lot regex treats the hyphen in `Lot N-2` as the title separator. Real/template lines like [BRANCH_TEMPLATE.md](/home/antoinefa/src/sentropic/plan/BRANCH_TEMPLATE.md:110) parse as title/slug `2`, violating “lotSlug from lot title, never index”; `[~]` real lot statuses are also dropped, e.g. [41a-BRANCH_feat-cowork-desktop-tools.md](/home/antoinefa/src/sentropic/plan/41a-BRANCH_feat-cowork-desktop-tools.md:327). Fix: parse the lot ordinal separately, require spaced dash separators, support title-after-bold forms, and decide `[~]` handling explicitly.

- **minor** [src/track.ts](/home/antoinefa/src/track/src/track.ts:470): Criterion idempotency is exact `(lotId, statement)`, so slight UAT copy edits create duplicate criteria and old unknown criteria can keep acceptance non-pass. Fix: use stable UAT identity/locator where possible, or define copy edits as new criteria and provide a retirement/update path.

- **minor** [src/cli/index.ts](/home/antoinefa/src/track/src/cli/index.ts:75): `runCli(argv, io)` reads relative BRANCH paths against process cwd, not `io.cwd`. Actual bin usage is fine, but embedded tests/callers can read the wrong file. Fix: resolve non-absolute file args against `io.cwd`.

**Checks**
`src/events/*` unchanged in Lot 6 diff. `npm run typecheck` passed. `TMPDIR=/dev/shm npm test -- --configLoader runner` passed: 128/128.

**VERDICT: CHANGES-REQUIRED**