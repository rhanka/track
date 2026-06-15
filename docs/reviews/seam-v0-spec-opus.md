# SPEC REVIEW (Opus 4.8max) — harness↔track seam v0 FREEZE (track-side)

_Date: 2026-06-14 · Verdict: **SPEC-READY-WITH-CHANGES**. Converged with Codex 5.5xhigh on 2 MUST-FIX._

Verified against shipped 0.12.0. The structural-inertness safety claim is AIRTIGHT; the additive/minor-bump
analysis is correct; two cracks in the "one-field delta" claim must be settled with the architect before snapshot.

## Verified RIGHT
Envelope (INGEST_CONTRACT_VERSION 1.0.0, WORK_EVENT_ENVELOPE_KEYS, v:1 major-reject); the 7-field
`scope.verification` table; `acceptance.run`/`acceptance.link` unchanged; READ 1.7.0; the additive-hash
drop-when-absent pattern; under-lock `(workspace,clientToken)` idempotency.

## POINT 3 — "a path verdict can NEVER become a DONE/TO-DO item" — AIRTIGHT (no finding)
`verificationRuns` is read at exactly ONE site outside its own fold — `scope-validate.ts:173` (read-only,
advisory, pure, off-by-default `delivered-out-of-scope` only PUSHES a finding, never mutates state/appends).
`bucketOf` (buckets.ts:25-36) reads only blockers/realization/acceptanceStatus — NEVER `verificationRuns`.
`statusByLevel` is verdict-blind. The acceptance branch can re-bucket an ALREADY-`done` item via the shipped
frozen `acceptance.run→acceptanceStatus→requireAccepted` path — but never CREATES an item. Claim confirmed.

## POINT 1+2 (KEYSTONE) — OQ-1 understated; fix stays adapter-side
`fold.ts:298` keys `verificationRuns.set(payload.runId, …)` by BARE runId. One physical run fanned into N
per-check scope verdicts ⇒ N events PERSIST but the read Map collapses to 1 (N-1 silently lost) AND
`scope-validate`'s `latestRunByWp` tie-break degrades. **Re-keying track to (runId,wpRef) is REJECTED**: (a)
the wpRef-absent workspace-scoped run has no wpRef → reintroduces collision; (b) breaks the read contract +
pinned tests; (c) still collides on same-wpRef reuse. **Decision: adapter mints a globally-unique runId per
emitted verdict, ratified as a snapshot INVARIANT (not a convention); track stores verbatim + adds a regression
fixture proving the data-loss if violated.** The "one-field code delta" survives, but the freeze introduces a
cross-contract correctness DEPENDENCY track relies on yet cannot self-enforce. (SHOULD-FIX framing + MUST-FIX
snapshot invariant.)

## POINT 5 — acceptance fan-out: OQ-4 misframed, hides a MUST-FIX
`linkEvidence(criterionId,kind,locator)` takes NO evidenceId — it MINTS `this.newId()` server-side and returns
it (track.ts:565-579). `acceptance.run` REQUIRES `evidenceId` (contract.ts:194) and `recordRun` THROWS on
unknown evidence (track.ts:842). The harness cannot reference a same-stream link's minted id, so emit-ordering
alone does NOT fix it. **Decide: (A) two-phase acceptance emit (link → read `IngestResult.ids` → run), OR (B)
add a deterministic/caller-supplied evidenceId to `acceptance.link` — which makes the track delta TWO fields.**
MUST-FIX, settle before snapshot. (OQ-5 per-link token suffix `…:link:{criterionId}` CONFIRMED required; OQ-6
acceptance result binary `pass|fail` CONFIRMED — no `conditional` home.)

## POINT 4 — frozen contract: additive proven, minor bumps correct (one NIT)
`artifactLocator?` additive (byte-identical old logs). MINOR bumps correct. NIT: §3 must name
`assertVerificationRun`'s drop-when-absent NORMALIZATION explicitly (the additive-hash test depends on it).

## PRIORITIZED for the architect (before snapshot)
1. [MUST] runId uniqueness = ratified invariant (per-verdict projection id, not the physical run id); track adds
   a regression fixture; no re-keying.
2. [MUST] acceptance `evidenceId` is track-minted/not-harness-predictable → pick (A) two-phase or (B)
   deterministic caller-supplied evidenceId (=2-field delta).
3. [MUST] per-link clientToken suffix `…:acceptance:{evidenceId}:link:{criterionId}`.
4. [SHOULD] reframe the central claim: track code delta is small, but snapshot-level correctness deps exist.
5. [SHOULD] artifactLocator format/immutability = producer guarantee track records, never verifies.
6. [CONFIRM] acceptance result binary; category/security schema-artifact-only.
7. [NIT] §3 name the asserter drop-when-absent normalization.

**VERDICT: SPEC-READY-WITH-CHANGES.**
