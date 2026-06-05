# Lot v2.3a — Codex (gpt-5.5 xhigh) review

Review of the read-only MCP server + shared read command layer. Paired with `docs/reviews/lot-v2.3a-opus.md` (Opus 4.8, verdict **ship**).

## Round 1 — verdict: ship-with-changes
- **major (FIXED)** `src/mcp/server.ts` did not enforce its own enum/type schema: an invalid filter like `{ bucket: 'NOPE' }` was accepted and returned empty JSON (CLI rejects via `oneOf`), and `requireAccepted: "true"` was silently coerced to `false`. **Fix:** `dispatchReadTool` now validates every arg — `optEnum` (kind/bucket/realization/acceptance, throws "must be one of …"), `optBool` (requireAccepted/decisions, throws on non-boolean), `reqStr`/`optStr` for strings — from single-source `KINDS/BUCKETS/REALIZATIONS/ACCEPTANCES` arrays shared with the advertised JSON-Schema `enum`. Throws → `isError`. Tests added: invalid enum throws + round-trip `isError`; non-boolean `requireAccepted` throws; provenance null / freshness shape; empty-log; sequential `callTool`.
- **minor (FIXED)** non-query tools / edge logs under-tested → added the above.
- **Judgment (confirmed sound):** CLI refactor behavior-identical (`Track`/`TrackReader` both fold `readAll()` into the same `buildReport/query`; `queryText` keeps `JSON.stringify(rows,null,2)+'\n'`; gitHead/requireAccepted/decisions unchanged). MCP read-only holds: no git, caller supplies `baselineCommit`, tools only read `events.jsonl`/`head.json`; fixed `eventsPath` fine because `TrackReader` re-reads per call. Stdio bin: no stdout logging, stderr only on connect failure, shebang preserved. Subpath imports resolve via the SDK `./*` export wildcard.

## Round 2 — confirmation (partial)
Codex re-inspected the fix and confirmed before its turn ended: *"No schema/runtime drift shows up in the declared MCP properties"*; *"the allowed sets match the CLI's query boundary by set, including rejecting decision-only `acceptance:'n/a'`"*; *"explicit validators on the visible fields."* (No one-word verdict emitted — the run ended mid-`npm test`.) Combined with Opus `ship` and 201 green tests (incl. invalid-enum→isError round-trip, non-boolean rejection, byte-identical CLI≡MCP parity), the major is closed.

## Outcome
201 tests green, tsc + build clean, `track-mcp` bin packaged (shebang, in `dist/`). The MCP surface validates args as strictly as the CLI; parity is structural (one shared `reportText`/`queryText`).
