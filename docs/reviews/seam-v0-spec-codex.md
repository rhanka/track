# SPEC REVIEW (Codex 5.5xhigh) — harness↔track seam v0 FREEZE (track-side)

_Date: 2026-06-14 · Verdict: **SPEC-READY-WITH-CHANGES**. Converged with Opus 4.8 on 2 MUST-FIX (acceptance evidenceId fan-out; runId per-verdict projection)._

MUST-FIX: the acceptance fan-out is under-specified and not compatible with shipped track as written. `acceptance.link` has no `evidenceId` field and maps to `linkEvidence(criterionId, kind, locator)` ([contract.ts](/home/antoinefa/src/track/src/ingest/contract.ts:186), [map.ts](/home/antoinefa/src/track/src/ingest/map.ts:151)); `linkEvidence` mints the `evidenceId` ([track.ts](/home/antoinefa/src/track/src/track.ts:565)). `recordRun` then requires an already-linked evidence id and throws if unknown ([track.ts](/home/antoinefa/src/track/src/track.ts:582), [track.ts](/home/antoinefa/src/track/src/track.ts:839)). So §2.4/§5 “one `acceptance.run` + N `acceptance.link`” is not just an ordering caveat: for N criteria, shipped track’s model is N evidence records and therefore N runs, unless all evidence already exists. If the architect wants caller-supplied `evidenceId` on links, that is a track-side change beyond the one-field delta.

MUST-FIX: OQ-1 is real, but I would not change track keying for this freeze. `verificationRuns` is keyed by bare `runId` ([fold.ts](/home/antoinefa/src/track/src/state/fold.ts:46), [fold.ts](/home/antoinefa/src/track/src/state/fold.ts:298)); snapshots deserialize the same way ([snapshot.ts](/home/antoinefa/src/track/src/state/snapshot.ts:57)). Adapter-only is sufficient if the emitted `scope.verification.runId` is a per-check/per-target projection id. The doc must distinguish that from the physical harness run id currently shown as “stable per invocation” in §1.2. Otherwise either state collisions or idempotency collisions are guaranteed.

SHOULD-FIX: OQ-5 is too narrow. Track idempotency is `(workspace, clientToken)` on ingest ([ingest.ts](/home/antoinefa/src/track/src/ingest/ingest.ts:302), [ingest.ts](/home/antoinefa/src/track/src/ingest/ingest.ts:324)); intra-stream repeats are skipped after the first token ([ingest.ts](/home/antoinefa/src/track/src/ingest/ingest.ts:355), [ingest.ts](/home/antoinefa/src/track/src/ingest/ingest.ts:370)). Every emitted operation in a fan-out needs a unique token: scope check, each acceptance link, and each acceptance run. Also note `clientToken` is max 256 chars ([map.ts](/home/antoinefa/src/track/src/ingest/map.ts:28)); consider a hashed component convention.

SHOULD-FIX: tri-state derivation is correctly adapter-side, but the snapshot must freeze the violation severity enum and blocking/advisory mapping. Track only validates `verdict` as `clean|violation|conditional` ([verification.ts](/home/antoinefa/src/track/src/model/verification.ts:57)); it cannot prove the adapter derived it from severity.

Confirmed: structural inertness is airtight for `scope.verification`. The fold case only writes `state.verificationRuns` ([fold.ts](/home/antoinefa/src/track/src/state/fold.ts:293)); `bucketOf` reads blockers, realization, and optionally acceptance status, never verification runs ([buckets.ts](/home/antoinefa/src/track/src/report/buckets.ts:22)). `statusByLevel` delegates to `bucketOf` ([status-by-level.ts](/home/antoinefa/src/track/src/report/status-by-level.ts:57)). `scopeValidate` only reads latest verification and may emit a read finding ([scope-validate.ts](/home/antoinefa/src/track/src/read/scope-validate.ts:171), [scope-validate.ts](/home/antoinefa/src/track/src/read/scope-validate.ts:248)).

Confirmed: `artifactLocator?` is additive and a minor bump is right. Current ingest/read versions are `1.0.0` and `1.7.0` ([contract.ts](/home/antoinefa/src/track/src/ingest/contract.ts:8), [contract.ts](/home/antoinefa/src/track/src/read/contract.ts:45)); envelope keys stay fixed ([contract.ts](/home/antoinefa/src/track/src/ingest/contract.ts:68)). Add it to schema/assert/fold/read with drop-when-absent and old logs fold/hash identically.

NIT: §1.1’s “unknown minor ⇒ unknown kind” is imprecise. The wire only has `v:1`; old 0.12.0 rejects new payload fields as unknown fields ([map.ts](/home/antoinefa/src/track/src/ingest/map.ts:92)), not as an unknown minor.

**Verdict: SPEC-READY-WITH-CHANGES**

Prioritized architect questions before snapshot:

1. Is `target.acceptance.evidenceId` a pre-existing track evidence id, or should the adapter create evidence from `criterionIds`/locator? For N criteria, confirm N links + N runs, or accept a track-side caller-supplied evidence-id change.
2. Freeze id vocabulary: physical harness run id vs emitted per-check `scope.verification.runId`. Adapter-only is fine only if the emitted id is unique per check/target.
3. Freeze token grammar with per-operation uniqueness and <=256 chars; include link and run suffixes, not just branch tokens.
4. Freeze violation severity values and the blocking/advisory predicate used to derive `verdict`.
5. Confirm OQ-2: track keeps `wpRef` optional; fail-closed target enforcement stays adapter-side.
6. Confirm `artifactLocator` format/immutability owner and that `category/security` remain schema-artifact-only in v0.
