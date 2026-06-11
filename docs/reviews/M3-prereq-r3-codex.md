# FINAL CONVERGENCE REVIEW (round 3, Codex 5.5xhigh) — track concurrent-retry idempotency seam (Option B)

_Date: 2026-06-11 · Verdict: **SHIP** (no remaining MUST-FIX). Both round-2 BLOCK items closed by the seam. Pair CONVERGED._

No remaining MUST-FIX found.

1. RESOLVED: concurrent create-retry.
`appendCommand` runs the injected dedupe under the file lock after integrity validation and before framing: [store.ts](/home/antoinefa/src/track/src/events/store.ts:106), [store.ts](/home/antoinefa/src/track/src/events/store.ts:133). Ingest injects `(workspace, clientToken)` dedupe only for tokened commands: [ingest.ts](/home/antoinefa/src/track/src/ingest/ingest.ts:324), [ingest.ts](/home/antoinefa/src/track/src/ingest/ingest.ts:368). Stale-until-lock probes cover item.create, decision.create, blocker.raise: [idempotency.test.ts](/home/antoinefa/src/track/src/ingest/idempotency.test.ts:262), [idempotency.test.ts](/home/antoinefa/src/track/src/ingest/idempotency.test.ts:304), [idempotency.test.ts](/home/antoinefa/src/track/src/ingest/idempotency.test.ts:325).

2. RESOLVED: result-id fidelity.
`emitBatch` returns store-returned persisted/deduped events: [track.ts](/home/antoinefa/src/track/src/track.ts:870). Id-returning facades derive from persisted events: createItem [track.ts](/home/antoinefa/src/track/src/track.ts:188), createDecision [track.ts](/home/antoinefa/src/track/src/track.ts:346), openBlocker [track.ts](/home/antoinefa/src/track/src/track.ts:488), resolveExternalDependency [track.ts](/home/antoinefa/src/track/src/track.ts:545), addCriterion [track.ts](/home/antoinefa/src/track/src/track.ts:561), linkEvidence [track.ts](/home/antoinefa/src/track/src/track.ts:573). No id-returning facade still returns only a minted id.

3. RESOLVED: namespace by construction.
`workspaceDedupe` filters persisted originals by both token and `eventWorkspace === workspace`: [ingest.ts](/home/antoinefa/src/track/src/ingest/ingest.ts:324). Cross-workspace same-token tests cover normal and stale-until-lock paths: [idempotency.test.ts](/home/antoinefa/src/track/src/ingest/idempotency.test.ts:187), [idempotency.test.ts](/home/antoinefa/src/track/src/ingest/idempotency.test.ts:244). Tokenless commands pass no hook: [ingest.ts](/home/antoinefa/src/track/src/ingest/ingest.ts:368).

4. RESOLVED: workspace resolution.
Create workspaces fold from payload into item/decision state: [fold.ts](/home/antoinefa/src/track/src/state/fold.ts:101), [fold.ts](/home/antoinefa/src/track/src/state/fold.ts:137). Transitions resolve through aggregate state; blockers resolve through target item; synthetic verification resolves `verification:<workspace>` suffix: [ingest.ts](/home/antoinefa/src/track/src/ingest/ingest.ts:278). Undefined workspace does not match a real channel workspace in `tokenIndex`/`workspaceDedupe`: [ingest.ts](/home/antoinefa/src/track/src/ingest/ingest.ts:302), [ingest.ts](/home/antoinefa/src/track/src/ingest/ingest.ts:329).

5. RESOLVED: F1-F4 remain closed.
Default store dedupe remains `(clientToken, aggregateId)` Case A/B/C, with exact filtered returns and partial-overlap fail-closed: [store.ts](/home/antoinefa/src/track/src/events/store.ts:218), [store.ts](/home/antoinefa/src/track/src/events/store.ts:245), [store.ts](/home/antoinefa/src/track/src/events/store.ts:249), [store.ts](/home/antoinefa/src/track/src/events/store.ts:258). Integrity-before-dedup is intact: [store.ts](/home/antoinefa/src/track/src/events/store.ts:110). Tests cover batch return, exact-set, partial-overlap, corrupt-log-before-dedup: [store.test.ts](/home/antoinefa/src/track/src/events/store.test.ts:184), [store.test.ts](/home/antoinefa/src/track/src/events/store.test.ts:212), [store.test.ts](/home/antoinefa/src/track/src/events/store.test.ts:252), [store.test.ts](/home/antoinefa/src/track/src/events/store.test.ts:300).

6. RESOLVED: P0/FROZEN intact.
Dedupe returns before framing only after existing-log validation; real appends still materialize/hash/frame, append, write head, and verify receipt under lock: [store.ts](/home/antoinefa/src/track/src/events/store.ts:110), [store.ts](/home/antoinefa/src/track/src/events/store.ts:145), [store.ts](/home/antoinefa/src/track/src/events/store.ts:172), [store.ts](/home/antoinefa/src/track/src/events/store.ts:179), [store.ts](/home/antoinefa/src/track/src/events/store.ts:275). No event shape/hash/seq/prevHash/head framing path changed.

Verification: focused `src/ingest/idempotency.test.ts src/events/store.test.ts` passed 42/42; full `npm test` passed 583/583.

SHIP
