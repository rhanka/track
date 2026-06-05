# Lot v2.3a — adversarial review (Opus)

**Scope:** read-only MCP server (`track-mcp` bin) + the transport-agnostic read command layer
(`src/read/commands.ts`) that makes CLI≡MCP parity structural. READ-ONLY review; no source touched.

**Method:** read every in-scope file plus the supporting layer (`TrackReader`, `buildReport`/`query`,
formatters, `EventStore`, `Track` for the refactor diff). Ran `vitest` (mcp + cli + contract:
47/47 green), `tsc --noEmit` (clean), `tsc -p tsconfig.build.json` (clean), `npm pack --dry-run`,
and probed the installed `@modelcontextprotocol/sdk@1.29.0` exports map + `CallToolRequestSchema`
validation behavior directly.

**VERDICT: ship.** No blockers, no majors. The CLI refactor is behavior-identical, parity is
genuinely structural (one shared layer), the server is correctly wired and side-effect-free, the bin
is clean, and the SDK subpath specifiers resolve under NodeNext both installed and as-published. A
handful of minors/nits below — none gate the lot.

---

## 1. CLI refactor safety (Track → TrackReader)

**PASS — behavior-identical.** `cmdReport`/`cmdQuery` were the only two read commands moved onto
`TrackReader` + the shared layer. Verified field-by-field:

- **`cmdReport`** (`src/cli/index.ts:354`): same `baselineCommit = --commit ?? gitHead`, same
  `requireAccepted`/`decisions` boolean derivation (`=== true`), same `fmt(flags)`. `reportText`
  (`src/read/commands.ts:11`) calls `formatReport(reader.report(options), format)` — the *same*
  `formatReport` the old path used. `TrackReader.report` = `buildReport(fold(events), options)`,
  identical to `Track.report` (`src/track.ts:433`) which is `buildReport(this.state(), options)` and
  `state()` is `fold(store.readAll())`. Same inputs, same function ⇒ same bytes.
- **`cmdQuery`** (`src/cli/index.ts:372`): the json-newline path is **preserved**. `queryText`
  (`src/read/commands.ts:23`) does `format === 'json' ? JSON.stringify(rows,null,2)+'\n' :
  formatRows(...)` — byte-for-byte the old `rowsOut` json branch (`src/cli/index.ts:179`). The CLI's
  own `rowsOut` is still used by `item ls` and is unchanged. Both the inline `rowsOut` and
  `queryText` share the identical `${JSON.stringify(rows, null, 2)}\n` literal, so they cannot drift
  in the trailing-newline dimension.
- **Filter enum validation** unchanged — still done at the CLI boundary via `oneOf(...)` before the
  value reaches `queryText` (`src/cli/index.ts:379-387`). Invalid `--bucket`/`--kind`/etc. still
  throws `DomainError` → exit 1 (test `cli.test.ts:157`, `:234` green).
- **`gitHead` fallback** untouched (`src/cli/index.ts:82-93`): off-repo → `'HEAD'`. Both report and
  query still funnel through `opt(flags,'commit') ?? gitHead(io.cwd)`.
- **Missing/corrupt log error handling:** `cmdReport`/`cmdQuery` do **not** try/catch — but they
  never did. A malformed line throws from `EventStore.readAll` (`src/events/store.ts:41`) up through
  `runCli`'s outer catch (`src/cli/index.ts:172`) → `error: …` + exit 1. Same as before the refactor
  (the old `Track` path read the log the same way). `cmdValidate` keeps its dedicated
  `INVALID: …`-on-throw branch (`src/cli/index.ts:401`); it was **not** refactored onto the reader
  and still composes integrity + desync.

**`cli.test.ts` is green (all 19 cases).** The full-surface E2E (`cli.test.ts:85`) drives
report/query/validate post-refactor; the linked-accepted revocation case (`:210`) still exercises
query through the new shared layer.

No regressions found.

## 2. Parity — STRUCTURAL, not coincidental

**PASS.** The parity is real, not asserted by a hand-copied expectation:

- Both transports call the **same** `reportText`/`queryText` (`src/read/commands.ts`). CLI:
  `src/cli/index.ts:359` / `:376`. MCP: `src/mcp/server.ts:91` / `:100`. There is exactly one
  formatter path; neither adapter re-implements rendering.
- The parity test (`server.test.ts:64-80`) asserts `dispatchReadTool(...) === cliOut([...])` —
  comparing the MCP payload against the **actual CLI output buffer**, not a frozen string. If either
  adapter diverged, the byte compare breaks. This is the right test shape.

**Divergence on invalid filter input — analyzed, and the lenient MCP is SAFE.** The CLI rejects an
unknown `--bucket` via `oneOf`; the MCP path does *not* re-validate enums (`dispatchReadTool` only
checks `typeof === 'string'`, `src/mcp/server.ts:95-99`). But:

- The MCP **schema** declares `enum`s for `kind`/`bucket`/`realization`/`acceptance`
  (`src/mcp/server.ts:35-39`), so a schema-aware client is guided correctly.
- A client that *bypasses* the schema and sends `bucket:"NOPE"` does **not** error — it silently
  matches nothing (`query`'s filter is `r.bucket === filter.bucket`, `src/report/build.ts:107`), so
  the result is an empty array, never a crash, never a write. Read-only invariant holds; worst case
  is an empty result instead of a friendly error. Acceptable for a read tool, and it cannot produce
  a *wrong* (non-empty, mismatched) result.

→ **Minor (intentional asymmetry, document it):** see finding M-1.

## 3. MCP server correctness

**PASS.** `Server` low-level wiring is correct:

- `ListToolsRequestSchema` → `{ tools: READ_TOOLS }` (`src/mcp/server.ts:121`); `READ_TOOLS` is a
  frozen `as const` JSON-Schema array, test-pinned to exactly the 5 read tools
  (`server.test.ts:48`).
- `CallToolRequestSchema` → dispatch + `isError` wrapping (`src/mcp/server.ts:123-134`). On any
  throw it returns `{ content:[{type:'text', text: message}], isError:true }` — **no stack leak**
  (`error.message` only, never `error.stack`), no unhandled throw escaping the handler.
- **`request.params.arguments` undefined/non-object — SAFE, verified against the SDK.** I probed
  `CallToolRequestSchema.safeParse` directly: it **rejects** `arguments` of type array/string/
  number/null at the protocol layer (zod), and only `undefined` or a genuine object ever reach the
  handler. So `(args ?? {}) as Record<string, unknown>` (`src/mcp/server.ts:126`) can never receive
  a non-object — the cast is sound and `reqStr`'s `args[key]` indexing is robust. `undefined` →
  `{}`; the `reqStr` guard then throws `tool argument "baselineCommit" must be a string` → `isError`.
- **`reqStr` is robust** (`src/mcp/server.ts:69-72`): `typeof v !== 'string'` covers missing,
  null, number, object, array — all rejected with a clear, non-leaking message. Confirmed by
  `server.test.ts:88-92` and the end-to-end `isError` round-trip (`:119-120`).
- **Single fixed `eventsPath` over server lifetime — NOT a problem.** `TrackReader` holds only the
  path and re-reads the file on every call (`reader.events()` → `store.readAll()` per tool call;
  `src/read/contract.ts:78`). So a long-lived server reflects log growth between calls without
  rebinding. The only thing fixed is *which* file — correct for a per-cwd stdio server.

## 4. Read-only / side-effect-free

**PASS — airtight.** No tool can append or touch git/fs beyond reading the event file (+ the head
sidecar, read-only):

- Every dispatch branch routes through `TrackReader` read methods (`report`/`query`/`validate`/
  `branchProvenance`/`freshness`). None construct a `Track`, none call `appendCommand`,
  `appendAtomic`, `writeHead`, `mkdirSync`, or any write fs API. `grep` for `console.*`/
  `process.stdout`/write APIs in `src/mcp/` + `src/read/` is empty.
- `validate` reads `readHead(eventsPath)` (read-only) + `store.readAll()`. `freshness`/
  `branchProvenance` only read the event log + hash the **caller-supplied** `content` string (no
  file read of BRANCH.md — content comes over the wire). This is stricter than the CLI, which is the
  point.
- **"No git in the server; caller supplies `baselineCommit`" honored end-to-end.** `track_report`/
  `track_query` schemas mark `baselineCommit` **required** (`src/mcp/server.ts:25`,`:41`); dispatch
  fails closed via `reqStr` if absent. There is no `execFileSync`/`git`/`child_process` import
  anywhere under `src/mcp` or `src/read` — git lives only in `src/cli/index.ts:gitHead`. Confirmed.
- **Side-effect-free test exists** (`server.test.ts:94-102`): event count identical before/after
  invoking all five tools. Good.

## 5. The bin (`src/mcp/cli.ts`)

**PASS.**

- **Shebang preserved by tsc** — verified on the built artifact: `head -1 dist/mcp/cli.js` →
  `#!/usr/bin/env node`. (tsc preserves a leading shebang.)
- **Connect-failure path** is correct (`src/mcp/cli.ts:12-15`): `.catch` writes to **stderr** and
  `process.exit(1)`. Writing the failure to stderr (not stdout) is exactly right — it cannot corrupt
  the stdio JSON-RPC framing on stdout.
- **No stdout pollution.** Nothing in the bin, server, read layer, `TrackReader`, or `EventStore`
  read path writes to stdout. The JSON-RPC stream owns stdout exclusively. Clean.
- **Nit N-1 (executable bit):** the built `dist/mcp/cli.js` lands `-rw-rw-r--` (no `+x`). This is
  *fine for published consumers* — npm sets the exec bit on `bin` targets at install — but a local
  `node dist/mcp/cli.js` is fine and a direct `./dist/mcp/cli.js` would need the bit. Same situation
  as the existing `dist/cli/index.js`, so no regression; noting only for completeness.

## 6. Packaging

**PASS (owner chose normal-dep + separate bin; judging soundness only).**

- **Subpath specifiers are correct for NodeNext, installed *and* as-published.** The source imports
  `@modelcontextprotocol/sdk/server/index.js`, `/types.js`, `/server/stdio.js`, `/client/index.js`,
  `/inMemory.js` — all `.js`-suffixed. The SDK `exports` map has **no** exact keys for these; it
  resolves them through a wildcard `"./*": { import: "./dist/esm/*" }`. NodeNext requires the
  explicit `.js` extension for that wildcard to hit `dist/esm/server/index.js` — which is exactly
  what the code does. `tsc --noEmit` (type resolution) and the in-memory round-trip test (runtime
  resolution) both pass, proving the specifiers are right under the project's own `module:NodeNext`.
  These are the same specifiers a published consumer resolves, so they remain valid post-publish.
- **Install weight — real, but accepted.** `@modelcontextprotocol/sdk@1.29.0` is **~12 MB** and
  drags a heavy transitive tree: `express`, `hono` (~8 MB), `ajv` (~6 MB), `zod` (~13 MB on disk),
  `jose`, `cors`, `eventsource`, `pkce-challenge`, `zod-to-json-schema`, etc. For a published
  *library* that ships a CLI, this roughly **triples** the dependency footprint for the ~90% of
  consumers who only use `track`/`@sentropic/track/read` and never `track-mcp`.
  - **Minor M-2 (alternative, not a re-litigation):** since the owner deliberately chose a *separate
    bin* and a *normal* dep, the one cheap hardening available is to make the dependency
    **`optionalDependencies`** (or a lazy/dynamic `import()` inside `cli.ts`/`server.ts`) so a plain
    library/CLI install can skip it and `track-mcp` fails gracefully with an install hint if it's
    absent. This is a *soundness* observation, not a blocker — the current choice ships and works.
    Flagging so the trade-off is explicit in the record.
- `npm pack --dry-run`: `dist/mcp/*` and `dist/read/*` are included; `*.test.ts` excluded from the
  build (`tsconfig.build.json`), so no test bloat ships. `files:["dist"]` + the two `bin` entries +
  `exports` (`.` and `./read`) are coherent. The `./read` subpath is exported but the MCP server is
  **not** exported as a library entry (only the bin) — consistent with "separate bin" intent.

## 7. Test adequacy

**Good coverage; a few worthwhile gaps (all minor).**

Covered: tool-surface pin, constructs-without-throwing, report/query parity (incl. a filter),
`track_validate` ok-shape, missing/invalid required args, unknown-tool, **side-effect-free**, and a
**real in-memory client↔server round-trip** with both a success and an `isError` call. That hits the
high-value invariants.

Gaps (none gate ship):
- **M-3:** no test for `track_branch_provenance` / `track_freshness` *result shape* — only that they
  don't write (`server.test.ts:99-100`). A `freshness:"absent"`-on-empty-log and a
  provenance-after-import assertion would lock the JSON shape the skills consume.
- **N-2:** no empty-log report/query test through the MCP path (the fixture always seeds 3 events).
  Cheap to add; would pin the empty-buckets JSON.
- **N-3:** `track_validate` MCP shape isn't compared to the CLI `validate` output — and it
  **intentionally differs** (see M-1). A test asserting MCP-validate == `reader.validate()` (and a
  comment that it is *not* the CLI's integrity+desync union) would prevent a future "parity"
  regression report.
- **N-4:** no multiple-sequential-calls test on a single server instance proving the reader re-reads
  a grown log mid-session. The architecture supports it (per-call `readAll`); a test would document
  it.

---

## Findings table

| ID | Severity | File:line | What | Fix |
|----|----------|-----------|------|-----|
| M-1 | minor | `src/mcp/server.ts:102` & `src/cli/index.ts:407` | `track_validate` returns **integrity only**; CLI `validate` returns **integrity + desync**. Not byte- or semantically-identical — a "parity" claim on `validate` would be false. | Intentional and correct (desync reads arbitrary cwd files, which would break the read-only-to-event-file contract). Document it: a one-line note in `server.ts` near the `track_validate` case + the tool `description` ("integrity chain only; desync is a CLI/filesystem concern"). |
| M-2 | minor | `package.json:52` | SDK is a **normal** dep (~12 MB + express/hono/ajv/zod tree) on a published library; ~90% of consumers never touch `track-mcp`. | Owner-approved as-is. Optional hardening: move to `optionalDependencies` or a lazy `import()` in `cli.ts`/`server.ts`, with a graceful "install @modelcontextprotocol/sdk to use track-mcp" message. Not required to ship. |
| M-3 | minor | `src/mcp/server.test.ts` | No result-shape test for `track_branch_provenance` / `track_freshness`. | Add: empty-log `freshness` → `{status:'absent'}`; post-import `branchProvenance` → expected slug/hashes. |
| N-1 | nit | `dist/mcp/cli.js` (build output) | No exec bit on the built bin. | None needed — npm sets it on install; matches existing `track` bin. |
| N-2 | nit | `src/mcp/server.test.ts:20` | Fixture always seeds events; empty-log MCP path untested. | Add an empty-`.track` report/query case. |
| N-3 | nit | `src/mcp/server.test.ts:84` | MCP-validate shape not pinned vs the reader, nor noted as ≠ CLI. | Assert `dispatchReadTool(...,'track_validate') === JSON.stringify(reader.validate(),null,2)` + comment. |
| N-4 | nit | `src/mcp/server.test.ts` | No "two sequential calls see a grown log" test. | Append an event between two `dispatchReadTool` calls; assert the second reflects it. |

## What I explicitly verified did **not** break
- `cmdReport`/`cmdQuery` json trailing-newline, gitHead fallback, requireAccepted/decisions flags,
  filter enum validation, missing-log throw → exit 1.
- `cli.test.ts` (19 cases), `read/contract.test.ts`, `mcp/server.test.ts` — 47/47 green.
- `tsc --noEmit` clean; `tsc -p tsconfig.build.json` clean; shebang on both bins preserved.
- No git/child_process/stdout write anywhere under `src/mcp` or `src/read`.
- SDK subpath specifiers resolve via the wildcard export under NodeNext (type + runtime).
- `CallToolRequestSchema` rejects non-object `arguments` before the handler → the cast is safe.

**VERDICT: ship.**
