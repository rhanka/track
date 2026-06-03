Structurally, the §6 verbs are present and `src/events/*` is unchanged in the Lot 7 diff. `item realize sideways` and `decision outcome maybe` are rejected by domain transition guards; several other casted inputs are not.

**Findings**
- **blocker** [src/cli/index.ts](/home/antoinefa/src/track/src/cli/index.ts:271): `accept run <evidenceId> --result <x>` casts directly to `RunResult`.  
  Fix: validate `pass|fail` before `recordRun`, and ideally guard in the facade too.  
  Reachability: `--result maybe` records `result:"maybe"`; [acceptanceStatus](/home/antoinefa/src/track/src/accept/status.ts:21) only special-cases `fail`, so a current invalid run can compute as `pass`.

- **blocker** [src/cli/index.ts](/home/antoinefa/src/track/src/cli/index.ts:151): mutating enum inputs are mostly TypeScript casts, not runtime validation.  
  Fix: add shared enum parsers and facade-level guards for item kind, decision kind, gate/disposition, blocker kind/rule, evidence kind.  
  Reachability: `item new --kind bogus`, `decision new --kind bogus`, `blocker raise --kind bogus`, `--rule nonsense`, and `accept link --kind bogus` can persist hash-valid garbage that `validate` will not reject.

- **major** [src/cli/index.ts](/home/antoinefa/src/track/src/cli/index.ts:153): `--workspace` is documented as required, but `item new` and [decision new](/home/antoinefa/src/track/src/cli/index.ts:197) silently default it to `"default"`.  
  Fix: either require the flag or document/default it consistently.  
  Reachability: a typo/omission creates real backlog data in the wrong workspace instead of failing as a missing required flag.

- **major** [src/cli/index.ts](/home/antoinefa/src/track/src/cli/index.ts:319): read-side filters are also cast-only.  
  Fix: validate `kind`, `bucket`, `realization`, and `acceptance` before querying.  
  Reachability: `query --bucket NOPE` exits 0 with empty output; `item ls --kind bogus` does the same unless prior bad data exists.

- **major** [src/cli/index.ts](/home/antoinefa/src/track/src/cli/index.ts:266): `accept run --from x --format junk` is treated as JSON.  
  Fix: require exactly `junit|json`.  
  Reachability: invalid format over a JSON file can ingest runs; over XML it reports a parse failure instead of the real invalid flag.

- **major** [src/cli/desync.ts](/home/antoinefa/src/track/src/cli/desync.ts:28): desync validation accepts an existing `.md` file with no H1.  
  Fix: missing H1 should be a desync finding; then compare the H1 to the item title.  
  Reachability: `body: "docs/foo.md"` with a file lacking `# Title` returns `OK`, despite SPEC §4 requiring an H1 match.

- **major** [src/cli/index.ts](/home/antoinefa/src/track/src/cli/index.ts:210): `decision dossier` rewrites the dossier as `{ context, options: [], qa: [] }`.  
  Fix: accept a full typed dossier payload or merge with the existing dossier while validating shape.  
  Reachability: any existing options/QA/recommendation are erased from folded state by a context-only CLI edit.

- **minor** [src/track.ts](/home/antoinefa/src/track/src/track.ts:267): `blocker raise --kind decision` is advertised in CLI usage, but `openBlocker` only looks up refs in non-decision `state.items`.  
  Fix: remove `decision` from manual blocker raise usage, or support decision refs via `state.decisions`.  
  Reachability: a real decision id fails as `unknown ref item`.

**Checks**
`npm run typecheck` passed. `npm test` could not run in this read-only session: Vitest first tried to write `node_modules/.vite-temp`, and the alternate config loader then failed creating `/tmp/.../ssr`.

**VERDICT: CHANGES-REQUIRED**