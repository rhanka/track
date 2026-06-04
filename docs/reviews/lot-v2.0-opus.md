# Lot v2.0 — Adversarial review (Opus 4.8)

**Scope:** the curated, versioned, read-only "skill-facing read contract" + fail-closed stale-sidecar guard.
**Files:** `src/read/contract.ts`, `src/read/contract.test.ts`, `src/read/index.ts`, `src/index.ts:12`.
**Grounding:** `track.ts` (importBranch / branch.imported), `events/canonical.ts`, `events/validate.ts`, `events/store.ts`, `state/fold.ts`, `report/build.ts`.
**Method:** read all of the above; ran the suite (12/12 green); `tsc --noEmit` clean; wrote throwaway probes to confirm the freshness gap, latest-wins, and the malformed-`sourceHash` cast behavior empirically (probes deleted).

Verdict up front: **ship-with-changes.** The guard is genuinely fail-*closed* (it never opens on an unsafe state), read-only purity is clean, and latest-wins provenance is correct. But there is one **major correctness gap** (false-stale on no-delta re-import) that defeats the stated purpose for a real class of edits, plus two **major** soundness/contract gaps. None are blockers (fail-closed means the failure mode is "refuse to consume," never "trust a stale sidecar"), so this is shippable after the fixes below.

---

## Findings

### F1 — MAJOR — `freshness` is false-stale after a no-delta re-import; the chosen freshness test answers the wrong question
`src/read/contract.ts:108-116` (the test) ⇔ `src/track.ts:513-520` (the cause).

`importBranch` emits `branch.imported` **only when `created + updated > 0`** (`track.ts:514`). So `sourceHash` records the hash of *the last content that produced a delta*, NOT the hash of *the last content track was reconciled against*. `freshness` then tests `computeHash(liveContent) === storedSourceHash`, i.e. **byte-identity to the last importing content** — which is not the same as **"track reflects the current BRANCH.md."**

Confirmed by probe: import BASE; then re-import BASE with only the `## Objective` prose rewritten (parser yields identical lots/UAT ⇒ `{created:0, updated:0}` ⇒ no new `branch.imported`). `freshness(editedContent)` returns **stale** (`expected` = BASE's hash, `actual` = edited hash) even though track is fully current. Any prose-only edit, any whitespace/formatting churn, any change the parser ignores (gate sub-checkboxes, scope text, a `[ ]→[ ]` no-op) now reports stale and `requireFresh` throws — bricking skill consumption until some *unrelated* delta happens to re-stamp the hash.

This is the safe direction (fail-closed, never false-fresh), so it is not a blocker. But it makes `requireFresh` brittle exactly where BRANCH.md is most often edited (prose), and it contradicts PLAN-v2's framing that the `sourceHash` test proves currency. The reviewer's own framing question — *"is `computeHash(content)==storedSourceHash` the right freshness test given no-op re-import is silent?"* — answers **no**: it conflates "byte-identical to the importing snapshot" with "semantically reconciled."

**Concrete fix (pick one, smallest first):**
1. **Stamp provenance on every import, delta or not.** In `track.ts`, drop the `if (created + updated > 0)` gate around the `branch.imported` emit (or keep the count but always emit when `content` differs from the last stamped `sourceHash` for this locator). Then `sourceHash` genuinely means "the content track last saw," and `freshness` byte-test becomes correct. (Touches `track.ts`, which is outside this lot's files — so flag it as a v2.0 dependency, not a contract change: `branch.imported` shape is unchanged, only its emit cadence.)
2. If emit-cadence is deliberately delta-gated, then **freshness must not claim semantic currency** — rename/redocument the status as `byte-divergent` vs `byte-identical` and have `requireFresh` additionally accept "divergent-but-reconciled" by re-parsing+re-folding the live content and comparing the *derived state* to the stored state. Heavier; only if (1) is rejected.

Recommend (1). Either way, add a test: *prose-only re-import keeps `requireFresh` passing.*

---

### F2 — MAJOR — unsound `as Sha256` / `String()` casts on untyped payload; `BranchProvenance` can be a typed lie
`src/read/contract.ts:99-102`.

```ts
branchSlug: String(p.branchSlug),
sourceHash: p.sourceHash as Sha256,
```

`payload` fields are `unknown`. `validate` recomputes `contentHash` over *whatever the payload is*, so a hand-edited/tampered (but internally re-chained) log, or a future event-type drift, can carry `sourceHash: 12345` and still pass integrity. Probe confirmed: a numeric `sourceHash` flows straight out of `branchProvenance()` as `{sourceHash: 12345}` while statically typed `Sha256`. `BranchProvenance` is then a lie a consumer may serialize, compare, or render as a hash.

It *happens* to fail closed in `freshness` (a number never `===` a `sha256:` string ⇒ stale), but that's luck, not design — and `branchProvenance()` is itself a **public contract method**, independent of `freshness`. `String(p.branchSlug)` similarly coerces a missing slug to the literal string `"undefined"` rather than rejecting.

**Fix:** validate the payload shape before constructing provenance; treat a malformed `branch.imported` as **absent/integrity-broken**, not as silently-coerced data.
```ts
const ok = typeof p.sourceHash === 'string' && p.sourceHash.startsWith('sha256:')
        && typeof p.branchSlug === 'string'
if (p.locator !== locator || !ok) continue   // or record a malformed flag → requireFresh fails closed
found = { locator, branchSlug: p.branchSlug, sourceHash: p.sourceHash as Sha256, at: e.at }
```
Note: a *skipped-because-malformed* latest event would make `branchProvenance` fall back to an older valid one and report `fresh` against stale data — so prefer surfacing malformedness as a guard failure (carry it into `requireFresh`) rather than silently skipping. At minimum, do not emit a non-`sha256:` value through a `Sha256`-typed field.

---

### F3 — MAJOR — package-level surface still `export *`s internals; "curated" holds only at the module boundary
`src/index.ts:12` (`export * from './read/index.js'`) sitting under `src/index.ts:3-8` (`export * from './events/index.js'` … which re-exports `EventStore`, `computeHash`, `validate`, `writeHead`, `materialize`, `stripFrame`, `contentHashOf`, `readHead`).

The lot's headline deliverable is *"a curated public read API (not today's `export *`, which leaks internals)."* `read/index.ts` itself **is** curated (named re-exports — good). But the *package* entrypoint still spreads every internal module, so a consumer doing `import { … } from '@sentropic/track'` sees `EventStore.appendCommand`, `computeHash`, `writeHead`, etc., right next to `TrackReader`. The curation is invisible at the boundary that actually ships. `READ_CONTRACT_VERSION` + additive-only is meaningful *for the `read/` module*, but the "no `export *` leak" promise is not met at `src/index.ts`.

This is a real gap against the deliverable, but it is **pre-existing** (the MVP barrel was already `export *`) and the file's own comment (`contract.ts:2-3`) explicitly acknowledges "the MVP barrel still `export *`s internals; that is the LIBRARY surface." So it's a documentation-vs-deliverable mismatch, not a regression.

**Fix (cheap):** either (a) explicitly scope the deliverable — state in PLAN-v2/README that the *library* barrel stays broad and the *curated* surface is `@sentropic/track/read` (add a `package.json` `exports` subpath so skills import the curated entry and the broad barrel is not the skill-facing one); or (b) tighten `src/index.ts` to named exports. (a) is consistent with the code's intent and is the smaller change. Without one of these, "curated" is aspirational at the package level.

---

### F4 — MINOR — `requireFresh` runs `freshness` and `validate` but cannot distinguish *which* unsafe state on an absent log; message is fine, structure slightly lossy
`src/read/contract.ts:123-132`.

`requireFresh` computes `freshness` and `integrity` independently and throws if *either* is bad — correct and fail-closed for all four states (stale / absent / integrity-broken / and, via F-handling, malformed). Two small notes:
- On an **empty log** (`events: []`), `branchProvenance` returns undefined ⇒ `freshness = absent` ⇒ throws; `validate([], readHead)` is `ok:true` for an empty file with no head. So absent dominates — correct, but there is **no test** for the empty-log path distinct from the "locator never imported in a populated log" path (F6).
- `validate()` re-reads the whole event file a second time (once in `freshness→branchProvenance→events()`, again in `validate()→events()`), each call hitting `store.readAll()` ⇒ a fresh file read + full re-parse. For a guard called per skill invocation this is O(2×file) per call. Not a correctness issue; a `this.events()` memoization or a single read shared between the two would halve I/O. **nit-adjacent.**

No fix required beyond adding the missing tests (F6); optionally memoize.

---

### F5 — MINOR — `freshness` ignores `branchSlug`/locator drift; a re-import under a *different* slug to the *same* locator is invisible
`src/read/contract.ts:91-105`.

`branchProvenance` keys only on `locator` and returns the latest by stream order (correct). But if BRANCH.md's BR-id changes (e.g. file edited so `deriveBranchSlug` yields a new `branchSlug`) while the `locator` path stays constant, freshness still compares only hashes; the `branchSlug` field is informational and never checked. Probably fine (hash change ⇒ stale anyway), but worth a one-line note that **locator is the identity key** and slug is descriptive — otherwise a future reader may assume slug participates in the freshness decision. **nit.**

---

### F6 — MAJOR (test adequacy) — several guard-critical cases are untested; one parity test could pass for a shallow reason
`src/read/contract.test.ts`.

Missing cases the lot's own gate calls for:
- **Re-import to a NEW hash → freshness follows the latest** (latest-wins). Not tested. (I verified it works via probe, but it's the central provenance invariant and must be locked.)
- **No-delta re-import → freshness** (F1). The bug is entirely untested; a regression test here would have caught F1.
- **Multiple locators in one log** — `branchProvenance(A)` vs `branchProvenance(B)` independence; only single-locator + "never imported" are covered (`:79`, `:101`).
- **Empty / absent event file** — `new TrackReader(pathThatDoesNotExist)`: `report`/`query`/`validate`/`requireFresh` behavior. `readAll` returns `[]` for a missing file, so this should be graceful, but it is unverified.
- **Integrity break localized to the `branch.imported` event itself** (not the unrelated body text at `:131`). Tamper the `sourceHash` inside the `branch.imported` payload and assert `requireFresh` fails closed (ties to F2). The current integrity test (`:129-140`) tampers `item.created` body text, which is the easy case.
- **Parity under `requireAccepted:true` and `decisions:true`** — `report()`/`query()` parity (`:60-66`) only exercises the default options. The reader delegates to the same `buildReport`/`query`, so this is low-risk, but the parity claim is only proven for one options shape.

Also: the parity tests compare `JSON.stringify(reader.report(OPTS))` to `JSON.stringify(track.report(OPTS))`. Because both call the *same* `buildReport(fold(events))` with the *same* injected clock/ids, they're near-tautological — they prove the reader doesn't *re-order or mutate*, but they would **not** catch a reader that, say, folded a *different* event subset. A stronger parity test would assert against a **golden JSON fixture** (the lot's stated "golden fixture → stable JSON" deliverable), which is **absent**. Not passing-for-the-wrong-reason exactly, but thin.

**Fix:** add the six cases above + a golden-fixture snapshot for `report()`. The snapshot also discharges the "contract snapshot test (breaking field change fails CI)" gate, which I do not see implemented anywhere in `src/read/`.

---

### F7 — NIT — `READ_CONTRACT_VERSION` additive-only policy is documented but unenforced
`src/read/contract.ts:24-31`.

Good intent and clear doc. But nothing *tests* that the surface is additive-only — no snapshot of the exported type shape, no `expect(Object.keys(reader))` guard. The version string is hand-maintained; a breaking field removal would not fail CI (the gate the lot promises: "breaking field change fails CI"). Tie this to the F6 golden snapshot: snapshot the `Report`/`ReportRow`/`BranchProvenance`/`Freshness` shapes (e.g. a representative serialized instance) so a field removal/rename breaks the snapshot.

---

### F8 — NIT — `branch.imported` is still a no-op in `fold` (`state/fold.ts:254-256`)
Out of this lot's read path (the reader reads provenance straight from the raw log, not from folded state — correct, and the cleaner choice for a guard that must work even when fold is wrong). Just noting the `// branch.imported provenance is folded in Lot 6` comment is stale: it is **not** folded; it is read raw by the contract. Harmless. Consider correcting the comment to avoid a future reader assuming folded provenance exists.

---

## Cross-cutting judgments (the reviewer's 7 axes)

1. **Correctness of freshness/provenance** — latest-wins ✅ (probe-confirmed), wrong-event selection ✅ (filters `type==='branch.imported'` + `locator`), no off-by-one. **But** the freshness *test itself* answers the wrong question on no-delta re-imports → **F1**.
2. **Fail-closed completeness** — fails closed on stale / absent / integrity-broken / empty / missing-file (all four+). A caller cannot be fooled into *false-fresh* in any path I found (even the malformed-payload path lands on stale by luck — but fix F2 so it's by design). The freshness test is *too* eager (false-stale, F1), which is the safe-but-brittle direction.
3. **Read-only purity** — ✅ zero writes. `TrackReader` only constructs an `EventStore` and calls `readAll()` + `readHead()`; no `append*`, no `writeHead`, no `git`. Baseline commit is injected via `ReportOptions`. Clean.
4. **Contract/versioning** — module-level curation ✅; **package-level `export *` undercuts it** → **F3**. Version is additive-only by doc but **unenforced** → **F7**.
5. **Type safety under strict tsconfig** — `tsc --noEmit` clean, but the `as Sha256` / `String()` casts are **unsound** and produce a typed-lie on malformed payloads → **F2**. This is the kind of cast strict mode can't catch because the source is `unknown`.
6. **Test adequacy** — green but **thin**: missing latest-wins, no-delta, multi-locator, empty/absent, localized-integrity-break, options-parity, and the promised **golden snapshot / contract snapshot** → **F6/F7**. Parity tests are near-tautological (same builder, same inputs).
7. **Faithfulness to PLAN-v2/INTENTION** — record-only ✅, BRANCH.md-master ✅, no skill writes ✅, fail-closed ✅. The one infidelity is the *deliverable* ("not `export *`") not being met at the package boundary (F3) and the contract-snapshot gate being unimplemented (F6/F7).

---

## VERDICT: **ship-with-changes**

The guard is sound in its safety direction and the read path is pure — nothing here can let a stale sidecar usurp BRANCH.md, which is the whole point. Ship after:

- **F1 (major):** stamp `branch.imported` on every reconciling import (or redefine freshness) so a prose-only edit doesn't false-stale the guard. **+ test.**
- **F2 (major):** validate `branch.imported` payload shape; stop emitting a non-`sha256:` value through a `Sha256`-typed field; route malformed provenance to fail-closed. **+ test (localized tamper).**
- **F3 (major):** make "curated" true at the package boundary (subpath `exports` for `@sentropic/track/read`, or named exports in `src/index.ts`) — or explicitly scope the deliverable in PLAN/README.
- **F6/F7 (major/nit):** add latest-wins, no-delta, multi-locator, empty/absent, localized-integrity, options-parity tests + a **golden snapshot** discharging the promised contract-snapshot gate.

F4/F5/F8 are minor/nit — fold in opportunistically.
