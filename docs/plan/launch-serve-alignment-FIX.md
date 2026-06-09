# Launch/serve alignment — track-mcp must boot gracefully (fix spec)

**Date:** 2026-06-09 · **Status:** decided, build-ready · **Double-reviewed by the Codex 5.5xhigh + Opus
4.8max PAIR (converged).** Fixes a 0.9.0 regression: the P0 store-resolver made `track-mcp` **fail-loud at
boot** when no `.track` resolves. The owner: *"h2a doesn't have this problem — launch track in the same model
as h2a / remote / harness / the CLI."* Target: a patch release on top of 0.9.0.

## 1. The ecosystem launch/serve model (confirmed from the references)
Long-running agent-facing servers **boot unconditionally and advertise capabilities without requiring
pre-existing project state**; reads/discovery **degrade to empty + an actionable hint**; writes/explicit
provisioning keep strict preconditions. Store creation happens **only at the tool's designated creator path**.
- **h2a `mcp-serve` (primary ref):** resolves its root (`--root`/`H2A_ROOT`/default `~/h2a-workspace/.h2a`,
  not cwd), **never requires prior state**, lazily creates its bus root, read/list tools return `{...: []}` on
  empty state; auto-open/wake are best-effort, never crash the transport (`a2a-cli` `cli.ts:363/1472`,
  `runtime/mcp/server.ts:88`, `runtime/local-files/store.ts:271`, `handlers.ts:92`).
- **remote:** same launcher posture — missing deps/side-windows warn, never fail the run; the h2a bridge
  scaffolds idempotently, no overwrite/delete.
- **harness:** stateless, emit-only; advisory failures exit `0`, usage/input errors exit `2`.

**track's one deliberate divergence (kept):** `init` is the ONLY creator — track **resolves but never lazily
creates** `.track`. Correct per P0; but it must be expressed as *serve-empty*, **not a boot crash**.

## 2. The regression (0.9.0)
`resolveTrackDir` throws `TrackDirNotFoundError` for every non-init path when no ancestor `.track` exists
(`src/cli/resolve.ts`), and `src/mcp/cli.ts` turns that into a **startup `process.exit(1)`**. But the read
layer is already empty-safe (`EventStore.readAll()`→`[]`, `readHead`→`null`; `server.test.ts:126` proves
empty-log reads yield `validate.ok` + empty buckets). **0.9.0 only broke the entry gate, not the read path.**

## 3. The fix (serve/launch/read ergonomics only — the P0 WRITE guard is untouchable)
- **Add `resolveTrackDirOrNull`** (`src/cli/resolve.ts`): nearest-ancestor `.track` or **`null`** when none;
  **still throws on a bad explicit `--track-dir`/`TRACK_DIR`** (an explicit wrong path is a user error, not an
  unadopted repo). NEVER creates. `resolveTrackDir` (writers) stays exactly as-is.
- **`track-mcp` boots unconditionally** (`src/mcp/cli.ts`): drop the boot `exit(1)`; **resolve lazily per read
  call** (`--track-dir`→`TRACK_DIR`→nearest ancestor) so a `.track` created AFTER boot is picked up without a
  restart (the sentropic "init then serve" case); serve an empty view + a hint when unresolved; **never
  create**. Keep `connect().catch` fatal (real transport errors stay loud). A bad explicit override stays loud.
- **Empty MCP payloads, honest, `isError:false`** (hint as additive transport content, NOT in the JSON
  schema): `track_report`→empty buckets (`decisions:[]` only if requested); `track_query`→`[]`;
  `track_validate`→`{ok:true,findings:[]}`; `track_branch_provenance`→`null`; `track_freshness`→
  `{status:'absent'}`; `track_external_deps`→`[]`. Hint: `No .track resolved from <cwd>. Run \`track init\`…`.
- **CLI read vs write:** **writes** (`item`/`decision`/`blocker`/`accept`/`priority`/`branch`/`ingest`) keep
  `resolveTrackDir` + fail-loud + init-only + `AppendReceipt` — **unchanged**. **Reads** (`report`/`query`/
  `validate`) use `resolveTrackDirOrNull` → on null: **rc=0**, empty output, stderr init-hint, **no create**.
  `validate` on an absent store = integral empty stream (`ok:true`) + a no-store warning; a malformed EXISTING
  log stays invalid/nonzero as today.

## 4. Minimal patch + tests
**Patch:** `src/cli/resolve.ts` (+`resolveTrackDirOrNull`); `src/mcp/cli.ts` (unconditional boot, lazy
resolve); `src/mcp/server.ts` (options form + lazy read resolver + hint; keep the `eventsPath:string` form for
tests; reads stay side-effect-free); `src/cli/index.ts` (split the read group onto the non-throwing resolver).
**Do NOT touch** `EventStore.appendCommand`/`AppendReceipt`, `initTrackDir`, the write-path resolver, the event
contract.
**Tests:** MCP boots with no `.track` (`tools/list` works, **no dir created**); MCP read empty + `isError!==true`
+ hint contains `track init`; invalid args still `isError:true`; CLI reads rc=0 + empty + stderr hint + no
create; **writes still fail loud** (keep all `p0-write-loss.test.ts` green, unchanged).

## 5. Decisions taken (reversible)
Lazy per-call resolution (Codex — better than boot-once: serves a store created after boot). `resolveTrackDirOrNull`
null-form (Opus). Both micro-choices reversible.
