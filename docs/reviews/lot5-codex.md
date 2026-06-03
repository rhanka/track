**Findings**
- **MAJOR** [src/report/build.ts](/home/antoinefa/src/track/src/report/build.ts:89): `QueryFilter.kind` accepts `ItemKind`, including `decision`, but `query()` only flattens non-decision report buckets at lines 99-100.  
  Fix: either narrow the filter type/CLI to non-decision kinds, or return/query a union that includes `DecisionRow` when `kind:"decision"` or `decisions:true`.  
  Reachability: `track.query({ kind: "decision" }, opts)` silently returns `[]` even when decisions exist; Lot 6/7 CLI would inherit a false-negative `query --kind decision`.

- **MINOR** [src/report/format.ts](/home/antoinefa/src/track/src/report/format.ts:15): text/md render raw titles at lines 15, 32, and 47.  
  Fix: escape Markdown metacharacters for `md`, and normalize `\r?\n`/control characters for text and md rows.  
  Reachability: item/decision titles are user-controlled; a title containing newlines or markdown can inject fake headings/list rows or break bold formatting.

**Confirmed**
- `src/events/*` unchanged: path-scoped diff is empty.
- `bucketOf` matches §7 first-match precedence exactly; done + unaccepted under `requireAccepted` correctly falls through to `TO-DO`.
- `requireAccepted` default false and required `baselineCommit` are acceptable; CLI HEAD default can land in Lot 6/7.
- Priority sort is WSJF score desc, unprioritized after, id tie-break.
- Decision report view is absent by default and decisions do not enter item buckets.
- Known placeholders surface as described: cancelled/rejected linked-done refs keep targets `AWAITED`; no-go on already-done targets reports `DONE`. These are folded-state semantics, not Lot 5 projection bugs, but should not be papered over in report.

**Verification**
- `npm run typecheck` passed.
- `TMPDIR=/tmp npm test -- --configLoader runner` passed: 120/120. Plain `npm test` is blocked by read-only `.vite-temp`.

**VERDICT: CHANGES-REQUIRED**