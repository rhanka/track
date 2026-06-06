# D3 implementation review — Opus 4.8 (Lot-1 grade)

**Scope.** D3 ("hybrid A→B"): an additive, hash-covered `prov` field on the event core + the CLI
`by:'system'` mis-attribution fix. Touches the FROZEN Lot-1 event contract, so reviewed at Lot-1
grade. Read-only review against `feat/track-mvp` @ `7ff1a05`.

**Method.** Static read of `types.ts`, `track.ts`, `cli/index.ts`, `canonical.ts`, `frame.ts`,
`store.ts`, `validate.ts`, `fold.ts`, `read/contract.ts`, `mcp/server.ts`, the two test files, and
SPEC §3. Plus four empirical probes (additivity, hash-coverage, getter/Date rejection, batch prov
consistency) and the full suite (`205/205`) + `tsc --noEmit` (clean).

---

## Verdict: **SHIP**

`prov` is genuinely additive, fully hash-covered, and inherits the materialize-once / persist-via-
canonicalize A4 guarantees with no new escape hatch. The CLI attribution fix is correct and never
emits the reserved `'system'`. No blocker, no major. A handful of minors/nits below, none gating.

---

## 1. Additivity / backward-compat — PASS

- `EventCore.prov?` is optional (`types.ts:72`). `emitBatch` stamps it conditionally:
  `...(this.prov !== undefined ? { prov: this.prov } : {})` (`track.ts:597`) — the **key is omitted
  entirely**, never written as `prov:undefined`.
- Even if it *were* written as `undefined`, `canonicalize`/`materialize` drop `undefined` own keys
  (`canonical.ts:77, 124`). Probed both: `computeHash(coreNoProv) === computeHash({...,prov:undefined})`
  is **true**, and the canonical string of a no-prov core contains no `prov` token. ⇒ a pre-D3 core
  is **byte-identical** post-D3; existing `.track` logs validate unchanged and old `prevHash` chains
  still match.
- No path where *absent* prov changes a hash. Confirmed empirically.

## 2. Hash-domain integrity (A4) — PASS

- `prov` lives in `EventCore`, so `contentHashOf(core)` covers it (`frame.ts:10`), and `validate`
  recomputes over `stripFrame(e)` which retains `prov` (`frame.ts:15` drops only the integrity
  frame). Probed: a present `prov` **changes** the hash (it is covered), and tampering a persisted
  `"auth":"local-user"`→`"signed"` flips integrity to `ok:false` (the A4 test at
  `provenance.test.ts:57` asserts exactly this — a genuine `content-hash` finding).
- materialize-once + persist-via-canonicalize holds for `prov` exactly as for `payload`:
  `store.ts:93` materializes the **whole core** (prov included) once, then hashes AND persists that
  same inert snapshot.
- No Proxy/getter/Date evasion: `materialize` walks own descriptors and **fail-loud rejects** an
  accessor or a non-plain object *anywhere* in the core. Probed a getter-`prov.auth` → rejected
  (`accessor property "auth" is not supported`); probed a `Date`-valued prov field → rejected
  (`non-plain object … (Date)`). The CLI/Track only ever supplies a plain object literal
  (`CLI_PROV`, `cli/index.ts:98`), so the production path is inert by construction.

## 3. Frozen-contract safety — PASS

`prov` is a pure additive core field. It does not touch `seq`, `prevHash`, the positional chain, or
the `cmd`/`cmdId` batch semantics — `validate` (`validate.ts`) reads none of `prov` and is
unchanged. Probed a log carrying `prov`: integrity `ok`. This is an additive field, not a
stream/seq/chain change. SPEC §3 (lines 213, 216) is updated consistently and the threat model is
untouched.

## 4. Batch consistency — PASS

`emitBatch` stamps the single `this.prov` reference on **every** member of a multi-event command
before the store materializes each event independently (`track.ts:590-599`). Probed a
`createDecision` batch (`decision.created` + `blocker.opened`): both members carry deep-equal prov.
Because `store.ts:93` deep-clones each event via `materialize` before persisting, the shared
reference is not aliased in the log. All members SHOULD carry the same prov, and they do — there is
no member that should be exempt (the whole command shares one transport/trust).

## 5. CLI actor resolution — PASS

`cliActor(cwd)` (`cli/index.ts:100`):
1. `git config user.email` → `human:<email>` when non-empty;
2. else `$USER ?? $USERNAME` → `human:<user>`;
3. else `'cli:unknown'`.

git-absent / not-a-repo / `rev-parse`-fails all hit the `catch` and fall through; an **empty**
`user.email` returns `''` (`.trim()`), the `if (email)` guard is falsy, so it correctly falls
through (not `human:`). No branch yields `'system'`. The `human:`/`cli:` namespacing is sound, and
reserving `'system'` for autonomous/internal callers is honored — the facade default `by:'system'`
(`track.ts:102`) is the correct residual for a library/internal caller that supplies no actor (the
CLI always supplies one via `writeTrack`). `CLI_PROV={transport:'cli',proposed:false,auth:'local-user'}`
matches the contract.

Injection: `by` is `ActorId = string` (unconstrained), hashed as a plain JSON string. An
attacker-controlled `user.email` is JSON-escaped by the canonicalizer and is hash-covered, so it
cannot break canonicalization or tamper the chain — bounded. See minor (m1).

## 6. Forward-compat (M3) — PASS

`Provenance` (`types.ts:49`) leaves clean room: `auth` already includes `'signed'`, and the doc
comment reserves `sig`/`principal` as additive optionals. Adding those optionals later and flipping
`auth→'signed'` cannot contradict any 0.2.0 record (those records simply lack the new optional keys,
which canonicalize-drop). The `transport`/`auth` enums are forward-compatible (string unions, growable).

## 7. Read-path — PASS

`fold` (`fold.ts`) switches on `event.type` and reads only `event.payload`/`aggregateId`/`at` — it
never touches `prov`; the `default` branch ignores unmapped fields. `TrackReader`
(`read/contract.ts`) reports/queries via `fold` and reads `branch.imported` payload only — prov-blind.
The MCP server (`mcp/server.ts`) is **read-only** (constructs only `TrackReader`, no `Track`/append).
`validate`'s desync call `new Track(s).state()` (`cli/index.ts:433`) constructs with no prov and
calls `state()` = `fold(readAll())` — a pure read, no append. Nothing mis-reads an event with `prov`.

## 8. Test adequacy — PASS (with gaps, see minors)

Covered: additive-present (`provenance.test.ts:41`), absent/omitted-key (`:50`), tamper/A4 (`:57`),
CLI attribution never-`system` + prov shape (`cli.test.ts:240`). All pass.

---

## Findings

**(minor) m1 — `ActorId`/`by` is unconstrained; no length/charset bound on hashed `user.email`.**
`types.ts:6,69`. A hostile `git config user.email` (e.g. a multi-KB string, or control chars) flows
verbatim into the hashed core. It cannot break integrity (JSON-escaped, hash-covered) but it does
let an unbounded attacker string into the immutable log. *Fix (optional, future):* bound `by` length
at the CLI boundary (e.g. reject/truncate > 256 chars) in `cliActor`. Not gating — the threat is a
self-inflicted local git config, and the value is honestly attributed.

**(minor) m2 — `proposed`/`auth` are not cross-checked.**
Nothing enforces that `auth:'signed'` implies a signature, or that `transport:'cli'` implies
`proposed:false`. Today the only producer is the `CLI_PROV` literal, so this is vacuous, but when
M3/h2a adds producers a malformed `prov` (e.g. `auth:'signed'` with no `sig`) would still validate
(it is just hashed data; `validate` is integrity-only by design). *Fix (M3):* add a `prov` *shape*
check to the read contract / a lint, NOT to `validate` (keep the frozen integrity detector pure).
Flag for M3, not 0.2.0.

**(minor) m3 — test gaps.** Missing direct assertions for:
  - a **multi-event batch** all carrying the same prov (I probed it manually — passes; worth a
    permanent test since `emitBatch` is the stamping site);
  - a **log mixing** prov and non-prov events validating (probed — passes);
  - **branch-import** events carrying prov (importBranch goes through `emit`/`emitBatch`, so it does
    inherit `this.prov` — but a CLI `branch import` writes via `writeTrack`, so its `branch.imported`
    now carries `prov`; no test asserts this, and `TrackReader.branchProvenance` ignores prov so it's
    safe — worth one assertion to lock the read-path prov-blindness).

**(nit) n1 — version is `0.1.0`, brief says "Ships in 0.2.0."** `package.json:version` is still
`0.1.0`. If D3 ships as 0.2.0, bump it at release. Not part of this diff's correctness.

---

## Bottom line

The frozen Lot-1 contract is preserved: `prov` is additive (absent ⇒ byte-identical core), fully
hash-covered (A4 holds, tamper detected), batch-consistent, and invisible to every read path. The
CLI never emits `'system'` and attributes honestly. Minors are forward-looking (M3 shape-validation,
actor bounding) or test-hardening; none gate 0.2.0.

**SHIP.**
