# PLAN-v2 adversarial review — Opus 4.8 (r1)

> Target: `docs/plan/PLAN-v2.md`. Grounded in `INTENTION.md`, `docs/spec/SPEC.md`, `docs/plan/PLAN.md`, and the shipped MVP source (`src/events/*`, `src/state/fold.ts`, `src/track.ts`, `src/cli/index.ts`). Read-only review; no code or plan changes made.
> Method: adversarial. Each finding has SEVERITY · LOCATION · WHAT'S WRONG · FIX. Verdict at the end.

## Summary of posture

The plan is **directionally right and unusually disciplined**: it keeps the prime directive ("track records, never decides"), keeps `BRANCH.md` master, keeps h2a optional, sequences by reversibility not appetite, and gates the three hard milestones behind double-reviewed spikes. M2 is genuinely low-risk and worth committing. The problems are concentrated in (a) **two load-bearing hand-waves about the frozen contract** (M4's "per-writer stream + merge index", and the unstated truth that *multi-writer cannot satisfy the current `validate` invariants without a contract round*), (b) **a side-effect leak that undercuts the "read tools provably side-effect-free" MCP gate**, and (c) **a missing irreversible decision** (the event-schema/versioning policy) plus one **false-reversible default** (D3 write surface is a security posture, not a build-order toggle). None of these blocks starting M2; several must be fixed *in the plan text* before M4/v2.3 are credible.

---

## BLOCKERS

### B1 — M4's "per-writer stream + merge index, not a chain rewrite" is hand-wavy and, as worded, contradicts the frozen `validate` invariants
**Severity: blocker** (for M4 only; does not block M2)
**Location:** L19, L29, L65–68 (M4 scope/spike), L112 (Risks), Prime directive L9.

**What's wrong.** The frozen contract is not just "append event types / add read surfaces." It encodes three invariants that are *intrinsically single-global-stream* (`src/events/validate.ts`, `src/events/store.ts`):
1. **Positional `prevHash` chain** — `prevHash === previous *stream* event.contentHash` (validate.ts (ii)). This is a total order over *one* file. A "per-writer stream" has, by definition, two heads; concatenating them re-chains nothing — every event after the merge point fails (ii).
2. **Per-aggregate contiguous `seq`** — `seq == lastSeq(aggregate)+1`, strictly (validate.ts (iii); store.ts L79–87). Two writers that touch *the same aggregate* (e.g. both append a `realization.transition` to one Item) each compute `seq=N+1`. Any merge yields a duplicate/gap → guaranteed `aggregate-seq` finding. This is the *common* case for a backlog, not the rare one.
3. **`head.json` is a single `{streamLength, lastContentHash}` anchor** (head.ts; store.ts L112). One linear length; no notion of multiple heads.

So "per-writer stream + merge index" is not a no-op on the frozen contract — it is **either** (a) a *new* integrity model layered above the per-stream one (each writer keeps its own valid chain; a merge index imposes a deterministic global order and a *new* cross-stream hash), in which case `validate` itself must grow a v2 mode and **this is exactly the "new frozen-contract round (Codex+Opus, like Lot 1)" the prime directive demands** — the plan must say so explicitly and *budget it as a contract round*, not as an M4 implementation lot; **or** (b) it silently rewrites the single chain, which the plan rightly forbids. The plan's own risk line ("not a chain rewrite") asserts the conclusion without showing the mechanism, and the milestone table calls M4 "Low reversibility (touches the frozen core's read/merge model)" — correct — but then files it as an ordinary spike-gated milestone rather than as a **contract amendment with its own freeze**.

The deeper issue the spike must answer (and the plan must name as the spike's *pass/fail question*): **what is the deterministic global order across writer streams?** `fold` replays in **file/stream order** and `at` is explicitly non-authoritative (`fold.ts`; types.ts L52; SPEC §3 "no `(at,id)` sort"). A merge index needs a total order that is *not* wall-clock and *not* single-file position. Until that order is defined and proven convergent, "deterministic reconciliation" is a label, not a design.

**Fix.**
- Reword L65–68 / L112 to state plainly: *multi-writer requires a **frozen-contract v2 round** — a new positional/seq model (per-stream local chain + a cross-stream merge-index with its own anchor and its own `validate` mode), gated by Codex+Opus like Lot 1, **before** any M4 implementation lot.* Make the contract round a named deliverable, not an aside.
- Make the spike's **explicit pass/fail gate**: "define a deterministic total order across writer streams that is independent of wall-clock and single-file position, and exhibit a convergence proof sketch + an adversarial concatenation/interleave test that the *current* `validate` would reject and the *new* `validate` accepts/normalizes." If the spike cannot produce that order, M4 reduces to **D2's lease-lock option** (single-writer-per-lease, no merge) — which honestly may be the right answer and should be the *default*, not field-ownership merge (see B2).
- Add to the spike scope: same-aggregate concurrent writes (the case that breaks invariant (iii)) — the plan's per-field-ownership framing addresses field conflicts but **not** the `seq` collision, which is structural.

### B2 — D2's default (revision-vector + field-ownership merge) is the *highest-risk* option defaulted as the baseline; the lowest-risk option (h2a lease-lock, no merge) is buried as an alternative
**Severity: blocker** (decision-quality; mis-sets the whole M4 direction)
**Location:** L29, L66, D2 (L81).

**What's wrong.** The plan's own ordering principle is "ascending design risk." Yet D2 *defaults* to the option that forces a frozen-contract round and a convergence proof (field-ownership merge), and lists **lease-lock single-writer-per-lease (no merge)** — which needs *zero* change to the frozen single-stream contract because there is never a concurrent append to reconcile — as a mere alternative. INTENTION explicitly anchors the coordination model on h2a: "*Aligned with h2a's append-only + **lease-lock***" (Persistence) and "*multi-agent coordination… **DELEGATED** (optional sidecar)*" (boundary table). The boundary rule is that track does **not re-model** coordination. A field-ownership merge engine **is** track re-modeling concurrency control — precisely what boundary A says h2a owns. The defaulted option therefore also drifts from INTENTION (see D-drift below), not just from the risk ordering.

**Fix.** Flip the default: **D2 default = h2a lease-lock, single-writer-per-lease, no in-track merge** (zero frozen-contract impact; matches boundary A). Field-ownership merge becomes the *fallback* pursued **only if** the spike (B1) proves a convergent cross-stream order is cheap. State that lease-lock makes M4 mostly an *h2a-integration* milestone (lands near M3), not a core-contract milestone — which also fixes the M3/M4 ordering smell (see Major M-ORDER).

---

## MAJOR

### M-SIDEEFFECT — "read-only MCP tools provably side-effect-free" is falsified by the CLI's `git rev-parse` shell-out; the command layer doesn't own commit resolution
**Severity: major**
**Location:** L52–54 (v2.3 read tools / gate), L82 (D3), L27 (single command contract).

**What's wrong.** `report`/`query`/`validate` resolve the baseline commit by shelling out: `gitHead()` runs `execFileSync('git', ['rev-parse','HEAD'])` in `src/cli/index.ts` (L79–90, called by `cmdReport`/`cmdQuery`/`cmdItem ls`). That is (a) a process spawn — a real side effect and a sandbox/permission surface for an MCP server, and (b) **lives in the CLI adapter, not in the transport-agnostic command layer** the plan wants to extract (`Track` in `src/track.ts` is pure: it takes `baselineCommit` as input). So the plan's "extract the existing CLI verb table into a transport-agnostic command layer; CLI and MCP are thin adapters" is not free: commit resolution (and file reads in `branch import` / `accept run --from`, see M-PARITY) must be **lifted out of the command layer into per-transport adapters or injected as an explicit input**, or every "side-effect-free read tool" silently spawns `git`.

**Fix.** Add to v2.3 (and to D3's framing): the command layer takes **all** environment inputs as explicit parameters (`baselineCommit`, file contents) — no `execFileSync`, no `readFileSync` inside it. The CLI adapter resolves `git HEAD`; the MCP adapter requires the caller to pass `commit` (or injects a host-provided resolver). Make "no process spawn / no fs read inside a read tool" an explicit, testable clause of the "side-effect-free" gate, not a claim.

### M-PARITY — the CLI/MCP "byte-for-byte canonical events" parity test is real and good, but two MVP behaviors make naive parity *fail*, and the plan doesn't account for them
**Severity: major**
**Location:** L53–54 (parity test), L107, L111.

**What's wrong.** Events embed **non-deterministic fields minted inside the command layer**: every event `id` is a fresh `ulid()` and `at` is `new Date().toISOString()` (`src/track.ts` constructor; `emitBatch` L550–560). `contentHash` covers the core **including `id` and `at`** (SPEC §3; frame). Therefore two runs of the *same* command (let alone CLI vs MCP) produce **different** `contentHash`/`prevHash` — the byte-identical claim is only achievable by injecting the deterministic clock/id generator (`TrackOptions.now`/`newId`, which exist) in the parity *test*. That's fine, but the plan states the parity gate as if events are naturally byte-identical across transports. They are byte-identical **only because both adapters call the same `Track` with the same injected seeds** — i.e. the gate proves "same command layer," which is the actual thing worth proving. Conversely, if the MCP adapter ever mints its own ids/timestamps (e.g. a request id leaking into `by`/`at`), parity breaks. Also: `branch import` and `accept run --from` read files *by path*; an MCP tool cannot take a server-side path the same way a CLI does (path semantics differ across transports / sandboxes), so those two verbs cannot have literal CLI≡MCP parity on the same argument shape.

**Fix.** Reword the v2.3 gate: parity = "**both adapters invoke the identical command layer with identical injected clock+id+inputs and produce byte-identical canonical events**" (proving no adapter-side domain logic / no field minting). Explicitly **carve `branch import` / `accept run --from` out of literal-path parity** — for MCP, pass *content* not a path; assert parity on the *resulting events* given identical content. This is the right gate; it just needs to be stated as "same command layer, injected env," not "magically identical."

### M-IDEMPOTENT — v2.1 asserts an ingest idempotency property that the shipped code does **not** have
**Severity: major**
**Location:** L43 ("idempotent re-ingest (no duplicate runs for the same commit+locator)").

**What's wrong.** `Track.ingestRuns` (`src/track.ts` L350–380) appends one `acceptance.run` per matching evidence **unconditionally** every time it is called — there is no dedup on `(commit, locator)`. Re-running CI for the same commit appends duplicate `acceptance.run` events. The MVP `report`/status cascade tolerates this (latest run wins, `criterionStatus` over latest `TestRun`), so it's not a correctness bug *today*, but the plan lists "no duplicate runs for the same commit+locator" as a v2.1 **test/gate** — i.e. it's asserting a property that requires **new** code (a dedup/upsert keyed on `(evidenceId, commit)`), while the surrounding prose ("ingest already exists in MVP") implies it's already satisfied. A reviewer reading the plan would think v2.1 is wiring-only; it is wiring **+ a new idempotency guarantee on the append path** (which must not violate append-only — likely a *fold-level* dedup or a "skip if identical latest run for this commit" guard, not a mutation).

**Fix.** In v2.1, state the idempotency item as a **new deliverable**: "add commit+locator dedup at ingest (skip appending an `acceptance.run` whose `(evidenceId, commit, result)` equals the latest already-recorded run), preserving append-only." Keep the test, but stop implying it's already true. Note the design choice (suppress-on-append vs. tolerate-and-fold) explicitly — it's a small but real semantic decision.

### M-READCONTRACT — v2.0 "freeze the skill-facing read contract as a public API surface" has no current basis and needs a versioning policy that the plan never establishes
**Severity: major**
**Location:** L37–39 (v2.0), L38 (contract snapshot test), Test strategy L107.

**What's wrong.** Today the public barrel re-exports `* from report/index`, `* from state/index`, etc. (`src/index.ts`) — there is **no curated, versioned read surface**; it leaks internal types wholesale. v2.0 rightly wants to "freeze it as a public API surface" with a snapshot test. But freezing a JSON shape that *skills depend on* is a **non-reversible** commitment (breaking it breaks consumers), and the plan has **no event/output schema-versioning policy** anywhere (no `schemaVersion` on report rows, no SemVer-of-the-read-contract statement). The contract snapshot test catches *accidental* drift but says nothing about *intentional* evolution — how does a skill detect it's reading a v2 vs v3 report? This is the missing decision **D7** (below).

**Fix.** v2.0 must (a) define an **explicit, minimal** read surface (not `export *`), (b) stamp it with a `contractVersion`, and (c) state the compatibility policy (additive-only within a major; the snapshot test asserts no removal/retype). Tie to D7.

---

## MAJOR — sequencing / decision-set

### M-ORDER — M3-before-M4 ordering is asserted but, under the right D2 default, M4 collapses into M3; the table's "ascending risk" is internally inconsistent
**Severity: major**
**Location:** L15–23 (milestone table), L18–19, L88–103 (dependency order / mermaid).

**What's wrong.** The table ranks M4 (multi-writer) as the lowest reversibility / highest risk, *after* M3 (h2a sidecar). But INTENTION says multi-writer reconciliation is **delegated to h2a lease-lock**. If D2 defaults to lease-lock (B2), then M4's "concurrency" is *achieved by* M3's h2a integration (lease = single-writer-per-lease = the frozen contract already handles it). So M4-as-a-separate-core-milestone only exists if you reject the INTENTION-aligned default and build an in-track merge engine. The plan presents M3 and M4 as independent post-M2 spikes ("M3 / M4 / M5 are independent", L89, L100–102) — but they are **coupled through D2/D4**: the coordination-depth decision (D4) and the merge-model decision (D2) jointly determine whether M4 exists at all.

**Fix.** Make the M3/M4 coupling explicit: "M4's *existence and shape* depend on D2 — under lease-lock, M4 ⊂ M3 (no core-contract change); under field-ownership merge, M4 is a separate frozen-contract round (B1)." Don't draw M3 and M4 as independent until D2 is settled.

### M-D3-FALSEREVERSIBLE — D3 (MCP write surface) is framed as a reversible build-order default but is actually an irreversible **security posture** decision
**Severity: major**
**Location:** D3 (L82), L52 ("then write tools"), L17 ("MCP server" in M2).

**What's wrong.** The plan files D3 with a "low-risk" reversible default ("ship read tools first, gate write behind parity"). But once an MCP **write** surface ships in a published package, agents/hosts can mutate a system-of-record over a transport with a *different trust boundary* than the CLI (the CLI runs as the user; an MCP tool may run under a host/LLM with different authority). That is the moment you inherit: authorization (who may append?), `by`/actor attribution (today `by` defaults to `'system'` — `track.ts` L98 — an MCP writer must carry a *real* actor or every event is mis-attributed), and **partial-failure across transports** (an MCP call that appends a multi-event batch then drops the connection — is the batch durable? `appendCommand` is atomic per process, but the *client* doesn't learn the result). Shipping read-only and adding write later is reversible in code; the *posture* (track is now writable by non-CLI agents) is not something you walk back from a published package without a breaking change. The "default" understates this.

**Fix.** Re-tier D3 as **direction-level, non-reversible** (like D2/D4). Make the default *read-only MCP for M2* and require an explicit decision (with an actor-attribution + authorization design) before any write tool ships. Add to v2.3: an MCP write tool MUST carry a caller-supplied `by` (no `'system'` default over MCP) — this is also a frozen-contract *content* concern (actor attribution is in the hashed core).

### M-MISSING-D7 — no decision for event-schema / read-contract evolution policy
**Severity: major**
**Location:** Decisions block (L76–85) — absent. Touches L37–39, L47, M4.

**What's wrong.** The whole v2 thesis is "*append* event types and *add* read surfaces." But there is **no stated rule** for: how a new event `type` is introduced without breaking old folds (forward-compat of `fold`'s `default: break`); how the *output* read contract versions (M-READCONTRACT); whether old `.track/events.jsonl` written by 0.1.0 is guaranteed replayable by v2 (migration policy). The MVP's `fold` silently ignores unknown event types (`fold.ts` `default` case), which is a *good* forward-compat default — but it's *undocumented as a contract*, so a future lot could "tighten" it and break old logs. This is exactly a non-reversible direction decision the plan claims to surface but doesn't.

**Fix.** Add **D7 — schema & read-contract evolution**: *(a)* event types are additive-only; `fold` MUST ignore unknown types (pin the current behavior as contract); *(b)* the skill-facing read output carries `contractVersion`, additive-only within a major; *(c)* logs written by any 0.x are replayable by all later 0.x/1.x (state the migration guarantee, or its absence, explicitly). Default: as stated; it's mostly pinning existing good behavior, but it must be *named* because tightening it later is irreversible.

---

## MINOR

### m1 — "MCP lands in M2 at the lowest architectural cost" undersells the new surface area
**Severity: minor**
**Location:** L23, L24.
MCP is the lowest-*core*-cost feature but introduces a new dependency (`@modelcontextprotocol/sdk`), a new transport, a new auth/attribution surface (M-D3), and the command-layer extraction (M-SIDEEFFECT/M-PARITY). "Lowest architectural cost" is true only for the *domain core*; say "lowest core-contract cost, with new surface-area cost in the adapter/auth layer."

### m2 — v2.2 bundles a contract-touching item with cosmetic ones under one "no change to the frozen event contract" gate
**Severity: minor**
**Location:** L46–49.
`linked-accepted` / `decision-settled` resolution rules add **new blocker-resolution semantics** that the `fold`'s `isOpen` must implement (`fold.ts` L260–271 currently rejects `linked-accepted`). That's a fold/state change (additive, but not "cosmetic cleanup"). The `validate` "fix-it hint" item is fine (read-only). Split v2.2: (a) resolution-rule additions = a fold change with its own A-test; (b) genuinely additive/flagged config (`requireAccepted` per-workspace, hints, sub-checkbox semantics). The blanket gate "no change to the frozen event contract" is true (these are payload-level, not frame-level) but the wording hides that `fold` semantics change.

### m3 — `acceptanceStatus` "stale" semantics interact with the CI bridge's `--commit` in a way the plan should test
**Severity: minor**
**Location:** L42–43.
`stale` is computed against `baselineCommit` (SPEC §2.4; default = git HEAD). The CI bridge pushes runs `--commit $GITHUB_SHA`; `report` later runs against the *consumer's* HEAD. So a run pushed for commit X is `stale` for any reader at HEAD ≠ X — which is correct, but means "pass" is only visible when the reader passes `--commit X`. The plan's test "`stale` when `--commit` ≠ latest run commit" covers detection; add the dual: a CI-pushed `pass` is `pass` **only** at its own commit — document this as the intended CI semantics so it isn't mistaken for a bug.

### m4 — "CI dogfood (track feeds its own acceptance)" risks a bootstrap/circularity that should be acknowledged
**Severity: minor**
**Location:** L44, L107.
Lifting A6 into CI means track's own `.track/` is mutated by track's CI. If a regression makes `accept run --from` ingest wrong, the dogfood signal is *also* wrong (the meter measures itself). Keep the dogfood, but the *gate of record* for v2.1 must remain the fixture-based unit tests (deterministic), with dogfood as a secondary smoke. State that ordering so a green dogfood can't mask a broken ingest.

### m5 — D5 (embeddable-view contract) correctly deferred, but M5 still lists "decision dossiers" UI which surfaces *Decision* internals the SPEC keeps out of default report
**Severity: minor**
**Location:** L20, L70–72.
Fine as v2+, but note: dossiers expose option/Q&A/recommendation structure (SPEC §2.7) — a *presentation* concern explicitly "out of core" (INTENTION §Decision & presentation). Ensure M5 consumes via the read contract (M-READCONTRACT/D7), never reaches into `state`/`fold` internals. One line in M5 scope.

### m6 — dependency-order prose vs. mermaid mismatch on parallelism
**Severity: minor**
**Location:** L89 vs L91–103.
Prose says "v2.0 → v2.1 → v2.2 → v2.3 (mostly parallelizable)"; the arrow `→` reads sequential while "parallelizable" says otherwise; the mermaid shows v2.0/v2.1/v2.2 all from MVP (parallel) → v2.3. Align the prose arrow with the (correct) mermaid: v2.0‖v2.1‖v2.2, all gating v2.3.

---

## NITS

- **n1 (L9):** "may *append* event types" — pin that `fold` ignores unknown types as the *enabling* contract (see D7); otherwise "append event types" is unsafe for old readers. One clause.
- **n2 (L61):** the "3 anticipated h2a lib-evolution-requests" restate INTENTION verbatim — good; add "file as `lib-evolution-request` only *after* the M3 spike confirms the mapping" so they aren't filed speculatively (INTENTION: "do NOT file now").
- **n3 (L82, D3):** "read tools first … provably side-effect-free" — `validate` writes nothing but `report`/`query` shell to git (M-SIDEEFFECT); call `validate` the *only* trivially-pure read tool and treat the others as pure-given-injected-commit.
- **n4 (L107):** "Acceptance A1–A7 stay green throughout (regression gate)" — good and concrete; make it the *first* gate of every lot, not a trailing line.
- **n5 (Out of scope, L117–119):** consistent with INTENTION §Non-goals and SPEC §9; complete. Good that "auto-repair of prose↔log desync" is restated as a permanent non-goal (record-only).

---

## Scope completeness vs INTENTION §Non-goals + SPEC §9/§10 (audit)

Mapped every v2+ non-goal to a milestone:
- llm-mesh / LLM-as-decider — **correctly permanent-out** (L119). ✓
- multi-repo consolidation — **Later** (L21). ✓
- external backends — **Later + D6** (L21, L85). ✓
- MCP server — **M2/v2.3** (L51). ✓ (lifted from non-goal correctly)
- multi-host plugins — folded into v2.3 packaging via h2a `install-skills` (L52). ✓ but **under-specified**: depends on h2a evolution #2 (reusable install-skills) which is M3-gated — so MCP "packaged for reuse via h2a" in v2.3 has a hidden M3 dependency. **Flag:** v2.3 ships **standalone** MCP; the h2a-packaged path is M3+. (Plan says "standalone otherwise" — good, but make the dependency explicit, don't bundle.)
- UI / Svelte DS — **M5 + D5** (L70). ✓
- presentation renderers — **Later** (L21, L119). ✓
- real-time sync — **out** (L119). ✓
- binding decisions via h2a negotiation — **M3** (L61). ✓
- **SPEC §10 deferred items:** multi-writer→M4 ✓; CI push→v2.1 ✓; `resolutionRule` beyond linked-done→v2.2 ✓; `requireAccepted` per-workspace→v2.2 ✓; desync auto-repair→**permanent non-goal** ✓; gate sub-checkbox semantics→v2.2 ✓.

**Missing / mis-placed:**
- **Prose↔event-log round-trip / desync (INTENTION Open-Q 2)** — only the *non-repair* side is addressed (v2.2 "fix-it hint"). The **regeneration rule** (INTENTION Open-Q 2: "regeneration rule + desync detection") — i.e. can prose be *regenerated* from the log — is neither scheduled nor declared out. Either schedule it or add it to "Out of scope (still)." **(gap)**
- **`stp track` sub-command registration** (INTENTION §Distribution: "registered after BR-42a ships the sub-command mechanism") — not mentioned anywhere in v2. It's a distribution surface parallel to MCP. Either fold into v2.3/M2 distribution or note it as cross-repo-blocked. **(gap, minor)**
- **Scheme registry beyond WSJF** (SPEC §9 non-goal; INTENTION "Other schemes later") — not placed. Minor, but "RICE/MoSCoW/manual rank later" has no home. Add to "Later." **(gap, nit)**

## D1–D6 decision-set audit

- **D1 (order):** right to escalate; default sane. But see M-ORDER — D1 can't be settled independently of D2 (M4's existence depends on D2). Couple them.
- **D2 (merge model):** right to escalate; **default is wrong** (B2 — flip to lease-lock).
- **D3 (MCP write):** **mis-tiered as reversible** (M-D3-FALSEREVERSIBLE — it's a security posture). Promote to non-reversible.
- **D4 (h2a coupling):** right; default (optional sidecar) matches INTENTION. ✓ Best-formed decision in the set.
- **D5 (embeddable-view contract):** right; correctly "not track's call alone." ✓
- **D6 (external backends):** right; "none until pulled" matches INTENTION. ✓
- **Missing D7 (schema/read-contract evolution):** add (M-MISSING-D7). Non-reversible.

So: D3 is the one false-reversible; D7 is the one missing; D2's default is the one unsafe default. D1/D4/D5/D6 are well-formed.

## Faithfulness-to-INTENTION drift summary

- **No** drift on: record-only (v2.0 "track stays record-only; zero writes from skills"), BRANCH.md master (L37 pin), h2a optional (D4 default), LLM-proposes-deterministic-rules-decide (L66 verbatim), validate-never-auto-repairs (L47, L119). These are faithfully carried. **This is the plan's strongest dimension.**
- **Drift risk #1:** D2 default (field-ownership merge) re-models concurrency that INTENTION delegates to h2a lease-lock (B2) — track would be re-modeling coordination, violating boundary A's "never the model."
- **Drift risk #2:** v2.3 MCP write surface defaults `by:'system'` (M-D3) — INTENTION's signed-journal/identity story (REUSED from h2a) implies real actor attribution; a `'system'`-attributed MCP write is a quiet identity regression.

---

## Testability of the proposed gates (verdict per gate)

- **CLI/MCP parity (byte-identical canonical events):** **real and the right gate**, but only under injected clock/id and content-not-path inputs (M-PARITY). As literally worded it's untestable for `branch import`/`accept run --from`. Fixable by wording.
- **Contract snapshot (skill read API):** **real** for accidental drift; **insufficient** for intentional evolution without D7/`contractVersion` (M-READCONTRACT).
- **CI dogfood:** **real but circular** as a gate-of-record (m4) — keep as smoke, not as the authority.
- **Lot-1-grade merge review (M4):** **necessary but not yet a test** — there is no adversarial harness for a cross-stream merge index because the order it would test isn't defined (B1). The claim "reuses the Lot-1 adversarial harness against the merge index" is **premature**: the Lot-1 harness tests a single chain; a merge index needs a *new* harness for interleave/convergence. Don't claim reuse until the order exists.
- **A1–A7 regression gate:** **real, deterministic, already shipped** — the soundest gate in the plan. Keep as the per-lot entry gate (n4).

---

## VERDICT

**approve-with-changes** — commit M2 (v2.0–v2.3) now, but **before building v2.3**: fix M-SIDEEFFECT/M-PARITY (command layer owns no fs/git; parity = same-layer-injected-env), re-tier D3 to non-reversible + require caller `by` (M-D3), reword v2.1's idempotency as a *new* deliverable (M-IDEMPOTENT), and add D7 + a versioned read contract (M-READCONTRACT). **Do not** start M4 until the plan is reworded to (a) make M4 a frozen-contract round, not an ordinary spike (B1), (b) flip D2's default to h2a lease-lock (B2), and (c) define the cross-stream deterministic order as the spike's pass/fail gate. M3/M5 are correctly spike-gated and need only the minor couplings noted.
