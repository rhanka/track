# P0 — silent write-loss (`track` rc=0 persists nothing) — fix spec

**Date:** 2026-06-09 · **Status:** decided, build-ready · **Double-reviewed by the Codex 5.5xhigh + Opus
4.8max PAIR (converged).** Origin: a remote agent on 0.2.x reported `track item new/realize/spec/accept`
returning **rc=0 with `events.jsonl` mtime unchanged**. WP1 (Record Integrity), top priority.

## Root cause (pair ranking)
Two candidates, **both consistent with "watched mtime unchanged"**, not disambiguated by the evidence:
- **(a) stale npx / pre-0.2.1 bin** (Opus #1): a cached **pre-0.2.1** build hits the old main-module guard on
  the install symlink → `track` exits 0 without running. **0.2.x-only; 0.8.0 source is clean.**
- **(b) `.track`/cwd split** (Codex #1): the CLI writes to `join(cwd,'.track')` with **no nearest-ancestor
  resolution**; from a subdir/worktree it persists to a **different** `.track` (auto-created) while the watched
  `events.jsonl` is untouched. **Affects 0.8.0 too.**
- **Refuted:** lock-contention silent no-op (`withFileLock` throws → rc=1; `track-mcp` is read-only, not a
  writer). Swallowed-error: none in source.
- **Discriminator (cheap, remote-side):** a stray `.track` elsewhere ⇒ (b); `track --version` shows an old
  number ⇒ (a).

## Fix — 3 layers (defense in depth; all warranted regardless of which cause)
1. **Shared store resolver** (CLI + MCP): walk **upward to the nearest existing `.track`**; **`track init` is
   the ONLY creator**; all other commands **fail loud** if none found; explicit override `--track-dir` /
   `TRACK_DIR`; `track-mcp` uses the same resolver and fails startup if unresolved. → kills (b)'s stray-write.
2. **The load-bearing guard — `AppendReceipt` post-write verification.** In `EventStore.appendCommand`,
   **under the same lock, after `appendAtomic`+`writeHead`, re-read** the persisted log/head and assert:
   `after.length === before.length + events.length` · the persisted suffix matches the generated events by
   `id` + `contentHash` · `head.streamLength` / `head.lastContentHash` match · `validate(after,head).ok`.
   On any mismatch **throw** (`append verification failed for <path>`). The CLI returns `0`/"ok" **only** on a
   verified receipt; genuine no-ops (`resolve-external` 0-match, dedup'd `ingest`/`accept run`) say **"no-op"**
   explicitly (whitelisted, never blanket-exempt). → makes **rc=0-without-persistence structurally impossible.**
3. **npx hygiene** (docs + a `track --version` check): pin `npx -p @sentropic/track@<exact>`; bust the npx
   cache; verify the resolved version before trusting a write. → kills (a).

## Tests (enforce the invariant)
- **cwd regression:** `track item new` from `repo/subdir` advances the **root** `.track/events.jsonl` and does
  NOT create `subdir/.track`.
- **append guard:** stub `appendAtomic` to no-op ⇒ `appendCommand` **throws "append verification failed"** and
  the CLI returns **rc=1**.
- **lock fail-loud:** pre-seed a live `<events>.lock` ⇒ write returns **rc=1 + clear stderr**, never rc=0.
- **bin guard:** keep the symlink `bin.test`; add an install-style `track --version` assertion; assert the
  `track` bin invoked with `argv[0]='track-mcp'` returns 2/USAGE, never 0.

## Scope
In-track (build now): the resolver, the `AppendReceipt` guard, the CLI rc-on-receipt rule, the tests. The npx
hygiene is docs + the version check. `track-mcp` stays read-only; future write paths must reuse the receipt
invariant and surface lock-timeout as `isError`, never success.
