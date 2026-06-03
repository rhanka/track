# Lot 6 Review — BRANCH.md import + minimal CLI (Milestone 1) — Opus 4.8

**Gate:** typecheck clean; `npm test` 128/128 green; `src/events/*` byte-unchanged. Read-only verified end-to-end against a real `21a-BRANCH_*.md` (file sha256 identical after import; 9 created / 2 updated; re-import 0/0).

## Idempotency / read-only — the hard parts CONFIRMED
- No-op re-import: 0 events. `branch.imported` emitted only when created+updated>0.
- CHANGED lot newly `[x]`: emits exactly the realization delta.
- Done lot re-import: no re-emit (done terminal, guard reads live state).
- Lot reordering: slug-based sourceKey → true no-op.
- Read-only: no write path to BRANCH.md.

## Findings (tested against the template + 7+ real BRANCH files)

- **major** `parse.ts` lot regex — `**Lot N-2** UAT` mis-parses: the hyphen in `N-2` is taken as the title separator → title/slug `"2"`, and the trailing `UAT` is lost. Hits BRANCH_TEMPLATE + real files (07/09/10/11/12/16/17). Fix: parse the ordinal separately, require a *spaced* dash separator, support title-after-bold; derive title from the descriptive part, not the index.
- **major** `parse.ts` lot regex — non-`[ xX]` markers (e.g. `[~]` deferred) silently DROP the lot (`41a` loses 2 real lots). Fix: widen the marker class and map unknown markers to a state (to-do) rather than dropping.
- **minor** `track.ts` UAT idempotency is exact `(lotId, statement)` → a re-worded UAT duplicates the criterion (SPEC §5 mandates `uatSlug` identity). Fix: resolve by `uatSlug`.
- **minor** `parse.ts` `branchSlug` reads BR-ID from `# Feature:` only → stub files with a different H1 lose their `BR-ID`. Fix: scan the whole document for a `BR-?\w+` token before the filename fallback.
- **nit** done-lot reconstruction injects an artificial `in-progress` (no direct `to-do→done` edge). Defensible for import; document. `[x]→[ ]` un-done correctly ignored.
- **nit** `cli` `parseFlags` can't accept a value starting with `--` (non-reachable for SHAs/formats). Lot 7 note.
- **nit** the parent `feature` lists as a bare TO-DO row. Spec-consistent; Lot 7 may group.

The two majors are data-fidelity defects against the very corpus A1 names. Fix (or scope out with a parser warning) before Lot 7 builds on this parser.

**VERDICT: CHANGES-REQUIRED**
