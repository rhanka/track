# harness↔track seam v0 FREEZE — track-side design

**Date:** 2026-06-14 · **Status:** SPEC/DESIGN draft (informs a later pair-review + TDD build — no code
shipped here). · **Upstream:** OWNER-RATIFIED v0 freeze of the harness→track seam, delivered by the sentropic
architect (`claude:architect`), double-consensus Opus 4.8 + Codex 5.5xhigh (converged). · **track:**
`@sentropic/track` 0.12.0 — record-only, append-only, event-sourced, FROZEN event contract; additive-evolution
pattern (additive optional fields hash byte-identically). · **Grounds against shipped:**
`harness-seam-and-scope-DESIGN.md` (§A seam + (c) ingestion + status(level)), `M3-channel-DESIGN.md`,
`src/ingest/{contract,ingest}.ts`, `src/model/{verification,acceptance}.ts`, `src/state/fold.ts`,
`src/report/buckets.ts`, `src/read/{scope-validate,contract}.ts`.

> **Scope of this doc.** track's job in the freeze: (1) converge a v0 JSON-Schema for contract-snapshot, and
> (2) evolve track's EXISTING `VerificationRun` ingestion to the ratified shape — ADDITIVELY, fail-closed,
> hash-identical old logs. This is the **JOINT-PR-PAIR** half (track's `VerificationRun-ingestion-v0 +
> artifactLocator + status(level)` ↔ harness `BR-H1 verification-run-v0-targets`), contract-snapshot both sides.
> Everything downstream ((a) scope.declare, (b) scope validate, harness BR-H2/H3, dogfood, doc-inversion) is
> OUT OF SCOPE here and ordered in §7.

---

## 0. The ratified shape (authoritative — transcribed, not invented)

- **S1 (KEYSTONE).** A VerificationRun carries a structured target **PER-CHECK**:
  `VerificationCheck.target = { scope?: {wpRef}, acceptance?: {evidenceId, kind:'unit'|'integration'|'e2e'|'manual', criterionIds?} }`.
  **≥1 target is REQUIRED** for a track-ingested check. A check with NO target **FAILS CLOSED at the adapter**
  (never auto-itemized, never glob-routed). Per-CHECK (not per-run) because one `harness verify` aggregates N
  checks across multiple WPs/criteria.
- **S2.** Canonical violation detail = the FULL VerificationRun JSON behind an immutable `artifactLocator`;
  `scope.verification.violations[]` is a **display/index projection** of deterministic
  `JSON.stringify({severity,code,path,message})`. TRACK GAP: track's `scope.verification` payload has NO
  locator today — **ADD `artifactLocator`** (store OPAQUE; track records, never fetches/owns the artifact store).
- **S3.** Verdict tri-state `clean|violation|conditional`, **DERIVED by the adapter** from violations+severity
  (any blocking ⇒ `violation`; advisory-only ⇒ `conditional`; none ⇒ `clean`), **NEVER from `result`**.
  `acceptance.run.result` uses the check pass/result directly.
- **S4.** Routing is driven by **TARGET, not category**: `target.scope` ⇒ `scope.verification`;
  `target.acceptance` ⇒ `acceptance.run` (+ one `acceptance.link` per criterionId). Category only
  validates/defaults the acceptance `kind`. **No implicit fanout** (each branch fires only when its target is
  present). **Idempotency:** harness sets `clientToken = verification-run:{runId}:{targetKind}:{targetId}`
  (race-safe end-to-end on track 0.12.0's under-lock `(workspace, clientToken)` idempotency).
- **S6.** v0 seam = **EVIDENCE ONLY**. The harness NARRATIVE `WorkEvent {schemaVersion,verb,status,refs,detail}`
  is NOT track's `{v,kind,payload}` and stays LOCAL to harness in v0 (narrative→track wrap is a deferred
  follow-on). **No narrative events on the seam in v0.**
- **ALSO.** Reserve `security` in `VerificationCategory` NOW (avoid a later major bump).
- **BRANCH PLAN.** Freeze the shape FIRST as a joint PR pair; contract-snapshot both sides. Then track's (a)
  scope.declare + (b) scope validate (internal (a)↔(c) order = track's call). Then harness BR-H2 (emit) → BR-H3
  (stp scope check) → dogfood → doc-inversion LAST. **MUST-NOT:** any adapter that infers target from
  path/category/branch; consuming `scope.verification` before the target field lands.

---

## 1. The v0 JSON-Schema artifact (contract-snapshot)

track publishes a consumable JSON-Schema/`.d.ts` for two layers. The harness validates its emit against this
artifact and emits `{v,kind,payload}` directly (never imports track runtime). Both sides contract-snapshot-test.

### 1.1 Envelope `{v,kind,payload[,clientToken]}` — SHIPPED, gels AS-IS

The ingest envelope (`src/ingest/contract.ts`, `INGEST_CONTRACT_VERSION = '1.0.0'`) is the v0 wire format and
needs **no shape change**:

- `v: 1` — unknown major ⇒ fail-closed reject; unknown minor ⇒ "unknown kind". (Confirmed compat rule.)
- `kind: WorkEventKind` — the freeze rides the EXISTING kinds `scope.verification`, `acceptance.run`,
  `acceptance.link` (no new kind).
- `payload: Record<string,unknown>` — per-kind validated by `WORK_EVENT_SCHEMA` (required + type + enum + NO
  unknown fields).
- `clientToken?: string` — the delivery idempotency key. The harness sets it per the S4 convention (§2.5).
- `WORK_EVENT_ENVELOPE_KEYS = ['v','kind','payload','clientToken']` — any other top-level key
  (actor/sponsor/proposed) is rejected fail-closed; WHO/trust come from the ingest CONTEXT.

> **Note for the snapshot.** The freeze publishes the *envelope* schema **and** the per-kind `payload` schema
> for the three seam kinds. The harness emits a SEQUENCE of these envelopes (one per check-target branch — §2),
> not a single "VerificationRun" envelope: the per-check VerificationRun object is the harness's INTERNAL
> artifact (behind `artifactLocator`), and the wire carries its target-routed projection.

### 1.2 The per-check VerificationRun shape (the harness internal artifact + its track projection)

The ratified per-check object the harness fans out from. track does NOT ingest this object whole — it ingests
its target-routed projection. The schema is published so both sides agree on the fields the adapter reads:

```jsonc
// VerificationRun (harness internal; behind artifactLocator) — published for contract-snapshot, NOT a track kind
{
  "runId":   "string",            // stable per `harness verify` invocation
  "runner":  "string",
  "commit":  "string",
  "env":     "string?",
  "artifactLocator": "string",    // immutable locator to THIS full JSON (S2) — OPAQUE to track
  "checks": [                     // N checks across WPs/criteria (S1 — per-CHECK target)
    {
      "category": "scope|acceptance|security",   // VALIDATES/DEFAULTS the acceptance kind; NOT routing (S4)
      "result":   "pass|fail",                   // the check's own pass/result (drives acceptance.run.result, S3)
      "violations": [ { "severity": "...", "code": "...", "path": "...", "message": "..." } ],
      "target": {                                // ≥1 of scope|acceptance REQUIRED; both empty ⇒ FAIL-CLOSED (S1)
        "scope":      { "wpRef": "ItemId" },
        "acceptance": { "evidenceId": "string", "kind": "unit|integration|e2e|manual", "criterionIds": ["..."] }
      }
    }
  ]
}
```

`VerificationCategory` enum (reserve `security` NOW): `'scope' | 'acceptance' | 'security'`.

### 1.3 The `scope.verification` payload — what stays, what is NEW

Shipped `VerificationRecordedPayload` (`src/model/verification.ts`) vs the v0 target:

| field           | shipped 0.12.0 | v0 freeze | note |
|-----------------|----------------|-----------|------|
| `runId`         | required       | required  | STAYS |
| `runner`        | required       | required  | STAYS |
| `commit`        | required       | required  | STAYS |
| `env?`          | optional       | optional  | STAYS |
| `verdict`       | required (`clean\|violation\|conditional`) | required | STAYS — but now adapter-DERIVED, never harness `result` (S3) |
| `wpRef?`        | optional       | optional  | STAYS — IS `target.scope.wpRef` (the scope-target routing key) |
| `violations?`   | optional `string[]` | optional `string[]` | STAYS — now the deterministic-`JSON.stringify` projection (S2) |
| **`artifactLocator?`** | — (ABSENT) | **NEW, optional** | the S2 GAP — added additively (§3) |

**STAY:** all seven shipped fields, unchanged types. **NEW (additive optional):** `artifactLocator?: string`.
No field is removed; no required field is added. `VerificationCategory` is NOT a `scope.verification` payload
field — it lives on the harness-internal check (1.2) and only validates/defaults the acceptance `kind` at the
adapter (S4); the `security` reservation is in the published enum, not the wire payload.

> The `acceptance.run` / `acceptance.link` payloads (`src/ingest/contract.ts`) are UNCHANGED by the freeze:
> `acceptance.run = {evidenceId, commit, env, runner, result}`; `acceptance.link = {criterionId, kind, locator}`.
> The freeze only adds a NEW caller (the adapter), not a new shape.

---

## 2. The adapter evolution (per-RUN → per-CHECK fan-out, target-driven routing)

### 2.1 Where the adapter lives

The adapter is **the harness's emit-side transcoder** — 100% OUTSIDE track (per §A "direction: harness EMITS →
track INGESTS; neither imports the other"). track ships NO new adapter code. track's only obligation is to
(a) accept the additive `artifactLocator` on `scope.verification` (§3), and (b) keep the three target kinds
(`scope.verification`, `acceptance.run`, `acceptance.link`) ingestible as today. This section SPECIFIES the
adapter contract the harness implements and that track's contract-snapshot pins.

> **MUST-NOT (transcribed).** No adapter that infers target from path/category/branch. The adapter reads
> `check.target` ONLY. Category is validation/default, never routing.

### 2.2 Per-RUN → per-CHECK fan-out

Shipped ingestion is per-RUN: one `scope.verification` WorkEvent ⇒ one `VerificationRun` keyed by `runId`, with
ONE optional `wpRef`. The freeze makes the harness fan a single `harness verify` (one `runId`, N `checks`) into
**one ingested evidence per `check.target` branch**:

```
for each check in run.checks:
  targets = []
  if check.target.scope?      → targets += scope-branch
  if check.target.acceptance? → targets += acceptance-branch
  if targets is empty         → FAIL CLOSED (S1) — emit nothing, surface a hard error (§2.3)
  for each target branch:      emit the routed WorkEvent(s) with the per-target clientToken (§2.5)
```

A check with BOTH `target.scope` and `target.acceptance` fans into BOTH branches (no implicit fanout — each
fires ONLY because its target is present, S4). One physical `runId` therefore produces multiple
`scope.verification-recorded` rows (distinct `runId`? — see §6 OQ-1) and/or multiple `acceptance.run` rows.

### 2.3 Fail-closed-no-target (S1)

A check whose `target` has neither `scope` nor `acceptance` is a HARD ERROR at the adapter: it emits NOTHING to
track and surfaces the failure (the harness aborts/flags the run). It is **never** auto-itemized, **never**
glob-routed, **never** routed by category/path/branch. This is enforced upstream of track — track's role is the
structural backstop: there is NO ingest path that turns a target-less artifact into a track write, because the
adapter is the only producer of these WorkEvents and it refuses to emit.

### 2.4 Target-driven routing (S4) into the EXISTING events

| `check.target.*` present | routed track WorkEvent(s) | facade reached |
|--------------------------|---------------------------|----------------|
| `target.scope.{wpRef}`   | one `scope.verification` (verdict = §2.6 derived; `wpRef` = the target; `artifactLocator`; `violations[]` projection) | `recordVerification(payload, {workspace})` |
| `target.acceptance.{evidenceId, kind, criterionIds?}` | one `acceptance.run` (`result` = check.result) **+ one `acceptance.link` per criterionId** | `recordRun(evidenceId, {...})` and `linkEvidence(criterionId, kind, locator)` per criterionId |

- **scope branch** ⇒ `scope.verification` ⇒ folds into `state.verificationRuns` (evidence-only, INERT to
  buckets — §2.7). `wpRef` present ⇒ recorded on the wpRef ITEM aggregate; absent (workspace-scoped) ⇒ the
  synthetic `verification:<workspace>` aggregate (shipped `recordVerification` behavior).
- **acceptance branch** ⇒ `acceptance.run` (the check's `result` drives `acceptance.run.result` DIRECTLY — S3)
  + one `acceptance.link` per `criterionId` (the link's `kind` = `check.target.acceptance.kind`, validated/
  defaulted by `category` — S4; `locator` = the per-criterion evidence locator, e.g. derived from
  `artifactLocator` — see §6 OQ-3). **Ordering caveat:** `recordRun(evidenceId,…)` requires the evidence to
  already exist (the shipped `acceptance.run` `resolveWorkspace` resolves workspace via
  `evidence → criterion → item`; `recordRun` throws on an unknown evidence). So the per-criterion
  `acceptance.link` (which mints/asserts the evidence) MUST be emitted BEFORE the `acceptance.run` for that
  evidence, OR the `evidenceId` must already be linked. Flag as OQ-4 (the evidenceId provenance/order).

### 2.5 The `clientToken` convention

The harness sets, PER target branch:
```
clientToken = verification-run:{runId}:{targetKind}:{targetId}
```
- `targetKind ∈ {scope, acceptance}`; `targetId` = `wpRef` (scope) or `evidenceId` (acceptance).
- One physical run + one check fanned into two branches gets TWO distinct tokens — each branch dedups
  independently. The per-criterion `acceptance.link` events under one acceptance branch need their OWN suffix
  (e.g. `…:acceptance:{evidenceId}:link:{criterionId}`) so each link is independently idempotent — flag as
  OQ-5 (token granularity for the link fan-out).
- **Race-safe end-to-end:** track 0.12.0 ships under-lock `(workspace, clientToken)` idempotency
  (`workspaceDedupe` in `src/ingest/ingest.ts`) — a concurrent retry dedups to ONE event even across a
  re-minted aggregateId. The token is workspace-namespaced (`eventWorkspace`), so a token reused in workspace V
  cannot suppress a write in W. The adapter MUST make `(runId, targetKind, targetId)` globally unique per
  intended write — it is, by construction (one verdict per (run, target)).

### 2.6 Tri-state verdict derivation (S3, adapter-computed)

The adapter computes the `scope.verification.verdict` from `check.violations` + severity, NEVER from
`check.result`:
- any violation with blocking severity ⇒ `violation`
- violations present but all advisory ⇒ `conditional`
- no violations ⇒ `clean`

track stores the derived verdict VERBATIM (shipped `assertVerificationRun` already validates the enum). The
acceptance branch is orthogonal: `acceptance.run.result` = the check's own `pass|fail` (S3) — never the
derived verdict.

### 2.7 EVIDENCE-ONLY (S6) + "a path verdict NEVER becomes a DONE/TO-DO item" (structural)

- **No narrative on the seam.** The harness narrative `WorkEvent {schemaVersion,verb,status,refs,detail}` is a
  DIFFERENT type from track's `{v,kind,payload}` and stays local to the harness in v0. The adapter emits ONLY
  evidence kinds (`scope.verification`, `acceptance.run`, `acceptance.link`). No `item.create`/`item.realize`/
  any narrative-derived write crosses the seam.
- **Structural guarantee (cite).** A `scope.verification` verdict folds into `state.verificationRuns` ONLY
  (`src/state/fold.ts` case `'scope.verification-recorded'` — "touches NO realization/bucket/blocker logic").
  Bucketing is `bucketOf` (`src/report/buckets.ts`), which reads ONLY `effectiveOpenBlockers`, `realization`,
  and (under `requireAccepted`) `acceptanceStatus` — it NEVER consults `verificationRuns`. Therefore a path
  verdict can NEVER spawn/advance/complete a TODO. `scope-validate.ts` reads `latestVerification`/
  `evidenceStatus` as a READ-only display, and its `status` is advisory (`rc` never a commit gate).
- The acceptance branch CAN influence buckets, but only through the SHIPPED, frozen acceptance path
  (`acceptance.run` → `acceptanceStatus` → `bucketOf` under `requireAccepted`) — i.e. it flips an
  already-`done` item's DONE-vs-TO-DO under the existing rule; it never creates an item. This is the EXISTING
  semantics, unchanged by the freeze.

---

## 3. The `scope.verification` payload `artifactLocator` addition (S2)

- **ADD** `artifactLocator?: string` to `VerificationRecordedPayload` and `VerificationRun`
  (`src/model/verification.ts`), to the `WORK_EVENT_SCHEMA['scope.verification'].fields`
  (`artifactLocator: str(false)`), to `assertVerificationRun` (validate it is a non-empty string when present;
  drop-when-absent to stay hash-minimal), and to the `'scope.verification-recorded'` fold case + the
  `verificationRuns` read projection (carry it through verbatim).
- **OPAQUE.** track STORES the locator and surfaces it on the read contract; it NEVER fetches, resolves, or
  owns the artifact store (same posture as `violations` recorded VERBATIM as opaque locators, and
  `spec-amend`'s `baseHash`/`resultHash` opaque integrity tags).
- **`violations[]` is a PROJECTION (S2 rule).** The canonical violation detail is the FULL VerificationRun JSON
  behind `artifactLocator`. `scope.verification.violations[]` is a DISPLAY/INDEX projection of deterministic
  `JSON.stringify({severity,code,path,message})` per violation. track's contract is unchanged
  (`violations: string[]`, recorded verbatim, never re-matched) — the freeze only PINS what each string is
  (the deterministic stringification) so the index is reproducible. track does not parse the strings.

---

## 4. Additive-vs-contract-bump analysis

**Frozen-contract invariant.** track's append-only event contract is frozen: old logs MUST fold byte-identically.
The additive-evolution pattern = NEW optional fields are dropped-when-absent in the asserter/fold, so an event
written before the field existed serializes identically. Confirmed across every prior lot (scope, canevas).

- **`INGEST_CONTRACT_VERSION` (`1.0.0`) — MINOR bump → `1.1.0`.** Adding `artifactLocator?` to
  `WORK_EVENT_SCHEMA['scope.verification']` is a backward-compatible producer-facing addition (a new OPTIONAL
  field; existing producers omit it and still validate; "NO unknown fields" still holds because the field is
  now KNOWN). A new producer field ⇒ minor, never major. **Not** a major bump: no kind removed, no required
  field added, no enum value removed.
- **`READ_CONTRACT_VERSION` (`1.7.0`) — MINOR bump → `1.8.0`.** `VerificationRun` gains an optional
  `artifactLocator` on the read surface (`verificationRuns(wpRef?)`). Additive read field ⇒ minor.
- **Old logs byte-identical.** A `scope.verification-recorded` event written at 0.12.0 (no `artifactLocator`)
  folds to the SAME `VerificationRun` (the new fold case spreads `...(payload.artifactLocator !== undefined ?
  {artifactLocator} : {})`, absent ⇒ omitted ⇒ identical object ⇒ identical `computeHash`). No re-write, no
  migration, no replay change.
- **Is anything a BREAKING change to the 0.11.0 `scope.verification` shape?** NO — IF the per-check target is
  carried by the EXISTING `wpRef` (scope branch) + EXISTING `acceptance.*` (acceptance branch), and
  `artifactLocator` is added OPTIONAL. The ratified S1 `target.scope.wpRef` maps 1:1 onto the shipped
  `wpRef`; `target.acceptance.*` maps onto the shipped `acceptance.run`+`acceptance.link`. **The breaking risk
  is entirely on the HARNESS/adapter side** (it must STOP emitting a target-less `scope.verification` — but
  track's `scope.verification` shipped with `wpRef` OPTIONAL, so a target-less wpRef-absent run is *currently
  legal* at track). See §6 OQ-2: do we tighten track to REQUIRE a target (`wpRef` required-when-scope-branch),
  or keep `wpRef` optional and rely on the adapter's fail-closed? **Recommended (additive):** keep track's
  `wpRef` OPTIONAL (the workspace-scoped synthetic-aggregate run is a legitimate shipped feature) and enforce
  fail-closed-no-target at the ADAPTER only — track stays additive, the adapter is the gate. If the architect
  wants track-level enforcement, that is a SEPARATE (potentially breaking) decision, flagged as OQ-2.
- **`VerificationCategory` + `security` reservation.** The enum lives on the harness-internal check + the
  published JSON-Schema, NOT on a track wire payload, so reserving `security` is a SCHEMA-artifact change only,
  zero track contract impact. (If a future lot promotes `category` onto the `scope.verification` payload, THAT
  is the moment to have `security` already reserved — pre-reserving now avoids a later major enum bump.)

**Net track delta:** ONE additive optional field (`artifactLocator`) across model/contract/fold/read, plus a
minor bump of both contract versions. Everything else (`wpRef`, `violations`, `verdict`, `acceptance.run`,
`acceptance.link`, the idempotency seam, status(level)) is ALREADY SHIPPED and UNCHANGED.

---

## 5. TDD test plan (cases the build must cover)

> Most cases are ADAPTER (harness-side) tests; the track-side build owns the `artifactLocator` round-trip,
> the additive-hash, and the structural-inertness cases. Marked `[track]` / `[adapter]` / `[snapshot]`.

1. **fail-closed-no-target** `[adapter]` — a check with `target:{}` (neither scope nor acceptance) emits ZERO
   WorkEvents and surfaces a hard error; assert no `scope.verification`/`acceptance.run` reaches `ingest`.
2. **scope-target → scope.verification** `[adapter]` — `target.scope.{wpRef}` ⇒ exactly one
   `scope.verification` with `wpRef` = target, derived verdict, `artifactLocator`, `violations[]` projection;
   `verificationRuns(wpRef)` returns it.
3. **acceptance-target → acceptance.run + link-per-criterion** `[adapter]` — `target.acceptance` with N
   `criterionIds` ⇒ one `acceptance.run` (`result` = check.result) + N `acceptance.link` (kind = target kind);
   assert link emitted BEFORE run (OQ-4 ordering), folded evidence + latestRun present.
4. **tri-state derivation** `[adapter]` — blocking-violation ⇒ `violation`; advisory-only ⇒ `conditional`;
   none ⇒ `clean`; and `acceptance.run.result` is `check.result`, NEVER the derived verdict (S3).
5. **clientToken idempotency fan-out** `[adapter+track]` — same `(runId,targetKind,targetId)` re-ingested ⇒
   exactly one persisted event (dedup), stable id; two branches of one check get distinct tokens; concurrent
   retry (parallel ingest) dedups under-lock to ONE (exercise `workspaceDedupe`); a token reused in workspace V
   does NOT suppress a write in W.
6. **artifactLocator round-trip** `[track]` — `recordVerification` with `artifactLocator` folds it into
   `state.verificationRuns` and surfaces it on `verificationRuns()`; absent ⇒ field omitted (hash-minimal).
7. **artifactLocator additive-hash** `[track]` — a `scope.verification-recorded` event WITHOUT `artifactLocator`
   produces a `VerificationRun` and a `computeHash` BYTE-IDENTICAL to the pre-freeze fixture (frozen-contract
   proof); a golden-log fixture from 0.12.0 folds unchanged.
8. **security category reserved** `[snapshot]` — the published `VerificationCategory` enum includes
   `'scope'|'acceptance'|'security'`; a check with `category:'security'` validates; the contract-snapshot pins
   the enum (so a later removal/rename fails the snapshot).
9. **status(level) unaffected** `[track]` — a `violation` `scope.verification` on a wpRef whose leaves are all
   `done` does NOT change the WP's bucket/rollup in `statusByLevel`/`bucketOf` (path verdict is INERT); the
   `delivered-out-of-scope` opt-in inference (scope validate) STILL surfaces it as a READ finding only.
10. **frozen contract intact** `[track]` — full event-log golden replay + `computeHash` over a pre-freeze
    fixture is unchanged; `INGEST_CONTRACT_VERSION`/`READ_CONTRACT_VERSION` bumped MINOR (not major); no kind
    removed, no required field added; `WORK_EVENT_ENVELOPE_KEYS` unchanged (still rejects extra envelope keys).
11. **target-driven routing, no implicit fanout** `[adapter]` — a check with BOTH targets fans into BOTH
    branches; a check with only `scope` emits NO `acceptance.run`; routing reads `target` only (assert a check
    whose `category` and `path` would "suggest" acceptance but whose `target.scope` is set routes to SCOPE).
12. **no narrative on the seam (S6)** `[adapter]` — assert the adapter NEVER emits any non-evidence kind
    (`item.*`/`decision.*`/narrative); only `scope.verification`/`acceptance.run`/`acceptance.link` cross.

---

## 6. Open questions / shape frictions (raise with the architect BEFORE snapshot)

- **OQ-1 — per-run→per-check `runId` collision.** track's `state.verificationRuns` is keyed by `runId`
  (latest-per-runId wins). One `harness verify` = one physical `runId` fanned into N scope-checks ⇒ N
  `scope.verification` events would all share `runId` and COLLIDE (last wins, N-1 lost). The adapter MUST mint a
  PER-CHECK runId (e.g. `{runId}#{checkIndex}` or `{runId}:{wpRef}`) — confirm the harness owns this and the
  freeze pins the convention. (track stores it verbatim; the collision is real if the adapter reuses the bare
  runId.) **This is the sharpest friction** — surface it first.
- **OQ-2 — target-less `scope.verification` legality at track.** track shipped `wpRef` OPTIONAL (a legitimate
  workspace-scoped synthetic-aggregate run). The ratified fail-closed-no-target is enforced at the ADAPTER.
  Confirm we do NOT tighten track to require a target (which would be breaking + would kill the workspace-scoped
  run). Recommended: adapter-only gate, track stays additive.
- **OQ-3 — `artifactLocator` format/owner.** Format (URI? content-hash? store-relative key?), immutability
  guarantee, and who owns the artifact store. track stores it OPAQUE either way, but the contract-snapshot
  should pin a STRING with a documented producer-owned format so consumers agree. Confirm "immutable" is a
  producer guarantee track records, not verifies.
- **OQ-4 — `evidenceId` provenance + link/run ordering.** The acceptance branch needs the `evidenceId` to exist
  before `acceptance.run` (shipped `recordRun` throws on unknown evidence; workspace is resolved via
  evidence→criterion→item). Who mints `evidenceId` — the harness (then `acceptance.link` mints it on first
  sight) or a pre-existing criterion link? Confirm the emit order (link-then-run) is the freeze convention.
- **OQ-5 — clientToken granularity for the link fan-out.** `verification-run:{runId}:{targetKind}:{targetId}`
  is one token per target branch, but the acceptance branch emits 1 run + N links. Each link needs an
  independently-idempotent token (e.g. `…:link:{criterionId}`). Confirm the per-link suffix convention.
- **OQ-6 — is per-check `result` retained / required?** S3 says `acceptance.run.result` = the check result.
  Confirm every acceptance-targeted check carries a `pass|fail` result (track's `acceptance.run.result` is
  REQUIRED `pass|fail`, no third state) — a `conditional`-style acceptance check has no home in the shipped
  enum. (Scope checks carry tri-state verdict; acceptance checks are binary.)
- **OQ-7 — does `category` ever land on the wire?** v0 keeps `category` harness-internal (validation/default
  only). Confirm the `security` reservation stays a schema-artifact-only reservation in v0, with promotion to a
  payload field deferred — so we lock the enum now without a track payload change.

---

## 7. Where this sits in the branch plan (out-of-scope ordering)

1. **THIS DOC → joint PR pair (FIRST).** harness `BR-H1 verification-run-v0-targets` ↔ track
   `VerificationRun-ingestion-v0 + artifactLocator + status(level)`; contract-snapshot BOTH sides. track delta:
   §3 additive `artifactLocator` + §4 minor bumps. **Freeze the shape before anything consumes it.**
2. track (a) `scope.declare` + (b) `scope validate` (internal (a)↔(c) order is track's call; both already
   designed in `harness-seam-and-scope-DESIGN.md` §B). OUT OF SCOPE here.
3. harness `BR-H2` (emit) → `BR-H3` (`stp scope check`) → dogfood → **doc-inversion LAST** (policy edit, zero
   code, gated green). OUT OF SCOPE here.

**MUST-NOT (re-stated):** no adapter inferring target from path/category/branch; do NOT consume
`scope.verification` before the target field lands (i.e. before this freeze ships on both sides).

---

## 8. Pair-review outcome (Codex 5.5xhigh + Opus 4.8max — CONVERGED: SPEC-READY-WITH-CHANGES)

Both reviewers verified every claim against shipped 0.12.0. The **structural-inertness safety claim is AIRTIGHT**
(verified: `bucketOf`/`statusByLevel`/`acceptanceStatus` NEVER read `verificationRuns`; the only reader is the
read-only/advisory/off-by-default `scope-validate` `delivered-out-of-scope` finding — a verdict can never mutate
item state). The additive/minor-bump analysis is **correct**. But TWO cross-contract MUST-FIX must be settled
with the architect BEFORE the contract-snapshot — the "one-field delta" survives for track's *code* but the
freeze adds correctness dependencies track cannot self-enforce:

- **M1 — runId is data-loss, not an open question (was OQ-1).** `fold.ts:298` keys `verificationRuns` by BARE
  `runId`; the per-check fan-out re-using one physical runId silently drops N-1 verdicts from the read surface +
  scope-validate. **Both reject re-keying track** (breaks the read contract; the wpRef-absent run has no key;
  still collides on same-wpRef reuse). **Resolution: the adapter MUST mint a globally-unique runId PER EMITTED
  VERDICT (a per-check/per-target projection id ≠ the physical "stable per invocation" run id of §1.2),
  RATIFIED as a snapshot INVARIANT.** track stores verbatim + adds a regression fixture proving the data-loss if
  violated. §1.2/§2.2 must distinguish physical-run-id from emitted-verdict-runId.

- **M2 — acceptance `evidenceId` is track-minted, not harness-predictable (reframes OQ-4).** `linkEvidence`
  takes NO evidenceId — it MINTS `this.newId()` server-side (track.ts:565-579); `acceptance.run` REQUIRES the id
  and `recordRun` THROWS on unknown (track.ts:842). The harness cannot reference a same-stream link's minted id,
  so "emit link before run" does NOT fix it. Also (Codex): one link = one evidence in shipped track, so "1 run +
  N links" is really **N×(link+run)** unless evidence pre-exists. **Decide: (A) two-phase emit (link → read
  `IngestResult.ids` → run), OR (B) a deterministic caller-supplied evidence key on `acceptance.link` —
  (B) makes the track delta TWO fields, not one.** track-side recommendation = **(B)**: a deterministic evidence
  identity fits track's "explicit/resolvable evidence target, no inference" philosophy + the 0.12.0 idempotency
  (single-phase, replayable), whereas (A) breaks fire-and-forget + retry-idempotence.

SHOULD-FIX (converged):
- **Token grammar (OQ-5 widened):** EVERY emitted op needs a unique `clientToken` — the scope check, EACH
  acceptance link, EACH run. Pin `…:acceptance:{evidenceId}:link:{criterionId}`. NB `clientToken` is **max 256
  chars** (map.ts:28) → consider a hashed component convention for long ids.
- **Freeze the violation severity enum + blocking/advisory predicate in the snapshot** (track only validates the
  `verdict` enum; it cannot prove the adapter derived it from severity — so the derivation rule must be pinned
  cross-contract, not just trusted).
- **artifactLocator (OQ-3):** pin a producer-owned string format; immutability is a producer guarantee track
  RECORDS, never verifies (same posture as spec-amend `baseHash`).
- **NIT:** §3 — name `assertVerificationRun`'s drop-when-absent NORMALIZATION of `artifactLocator` explicitly
  (the additive-hash test depends on it).

CONFIRMED as-is (ratify, no change): OQ-2 (track keeps `wpRef` optional; fail-closed stays adapter-side),
OQ-6 (acceptance result binary `pass|fail` — no `conditional` home), OQ-7 (`category`/`security` stay
schema-artifact-only off the wire).

**Build-gating:** the `artifactLocator` addition + the runId-invariant regression fixture are safe-regardless
and may build now; the **acceptance fan-out shape (M2 A-vs-B) gates whether the track delta is one field or
two** — so the TDD build of the acceptance branch waits on the architect's M2 decision. Reviews archived:
`docs/reviews/seam-v0-spec-{codex,opus}.md`.

---

## 9. Architect RATIFICATION (owner-ratified 2026-06-14) — UNBLOCKED, build now

The architect (`claude:architect`) accepted track's pair-review wholesale; owner-ratified (recorded in sentropic
`spec/SPEC_DECISION_SEAM_HARNESS_TRACK_V0.md §7`). Resolutions:

- **M1 = RATIFIED INVARIANT (harness-owned).** The adapter MINTS a globally-unique `runId` **per emitted
  verdict** (a per-check/per-target PROJECTION id, distinct from the physical run id which lives in the full run
  behind `artifactLocator`). No reused physical runId on the wire. **track ships the regression fixture** proving
  the read-surface data-loss if the invariant is violated (pins it cross-contract). track does NOT re-key.
- **M2 = B (track's préco).** A **deterministic caller-supplied evidence KEY** on `acceptance.link`;
  `acceptance.run` references it. So `target.acceptance.evidenceId` IS that caller-supplied deterministic key,
  NOT a server-minted id. (A) two-phase REJECTED. **track delta = TWO additive fields: `artifactLocator`
  (scope.verification) + a caller-supplied `evidenceId` on `acceptance.link`** (additive optional — defaults to
  the shipped server-mint when absent, so old callers are unbroken).
- **SHOULD-FIX both ADOPTED (mostly harness-side).** (i) `clientToken` unique per emitted op:
  `verification-run:{runId}:{targetKind}:{targetId}` and `…:acceptance:{evidenceId}:link:{criterionId}`; harness
  HASHES a component past the 256-char cap. track just keeps `clientToken` opaque ≤256 (already true). (ii) the
  snapshot FREEZES the violation severity enum (`advisory|blocking`) + the derivation predicate
  (blocking⇒violation; advisory-only⇒conditional; none⇒clean); harness guarantees severity is always set. This
  lives in the published schema artifact, NOT a track payload field.
- **CONFIRMS all RATIFIED (zero track change):** OQ-2 (`wpRef` optional + fail-closed adapter-side), OQ-3
  (`artifactLocator` producer-owned string; immutability = producer guarantee track records-never-verifies),
  OQ-6 (`acceptance.run.result` binary `pass|fail`), OQ-7 (`category`/`security` schema-artifact-only, off-wire).

**Track build (this lot, TDD, additive, frozen contract intact):** (1) `artifactLocator?` on `scope.verification`
(model + WORK_EVENT_SCHEMA + assertVerificationRun drop-when-absent normalization + fold + read projection);
(2) caller-supplied `evidenceId?` on `acceptance.link` (model + schema + `linkEvidence` honors it, defaults to
mint when absent); (3) the M1 runId-collision regression fixture; (4) publish the v0 JSON-Schema artifact
(WorkEvent envelope + per-check VerificationRun with `target` + `artifactLocator` + the acceptance evidence-key +
the frozen `VerificationCategory`/severity enums) for the JOINT contract-snapshot; (5) `INGEST_CONTRACT_VERSION`
+ `READ_CONTRACT_VERSION` minor bumps. Then send the architect the schema → harness BR-H1 lands against it as the
joint PR pair, contract-snapshot both sides.
