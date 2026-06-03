**Findings**
- **major** [src/accept/ingest.ts:45](/home/antoinefa/src/track/src/accept/ingest.ts:45): JSON ingestion treats every non-`fail`/`failed` status as `pass`, including missing status, `skipped`, `error`, typos, and primitive entries.  
  Fix: accept only explicit pass/pass-equivalent and fail/fail-equivalent; skip or reject unknown/skipped/malformed entries before appending. Reachability: `track.ingestRuns(json, ...)` can turn skipped/malformed JSON into `acceptance.run result:"pass"` and make acceptance falsely green.

- **major** [src/track.ts:335](/home/antoinefa/src/track/src/track.ts:335): `ingestRuns` uses `.find()` for locator matching, so duplicate locators update only the first evidence.  
  Fix: either enforce global locator uniqueness in `linkEvidence`, or emit runs for all matching evidence, or reject ambiguous locators atomically. Reachability: `linkEvidence` allows duplicate locators across items/criteria; a later failing report can update another item’s evidence while the intended item remains previously `pass`.

- **minor** [src/model/decision.ts:34](/home/antoinefa/src/track/src/model/decision.ts:34): `Dossier.decisionEvaluation` is still `unknown`, despite Lot 4b introducing `PriorityAssessment`.  
  Fix: type it as `PriorityAssessment` with a type-only import. Reachability: TypeScript callers can persist arbitrary dossier evaluation shapes, and Lot 5/report code cannot rely on the frozen WSJF snapshot without casts/guards.

- **minor** [src/accept/ingest.ts:29](/home/antoinefa/src/track/src/accept/ingest.ts:29): JUnit parsing is regex-based and can misread XML content, especially CDATA/text containing `<failure`/`<error`, and it only extracts double-quoted `name`.  
  Fix: use a small XML parser or at least validate attributes/entities and ignore CDATA/text when detecting failure elements. Reachability: valid passing JUnit with CDATA containing XML-like text can be ingested as `fail`.

- **minor** [src/state/snapshot.ts:45](/home/antoinefa/src/track/src/state/snapshot.ts:45): `deserializeState` assumes new `criteria`/`evidence` arrays exist, so pre-Lot-4 snapshots crash instead of rebuilding/defaulting empty maps.  
  Fix: default absent arrays to `[]` or version snapshots. Reachability: exported snapshot API on an existing workspace with older non-authoritative snapshots.

**Notes**
No finding on `accept/status.ts`: the criterion and item cascades are total and match §2.4 ordering, including fail over waiver, waiver before stale/unknown, mixed stale/pass, zero evidence without waiver ⇒ unknown, and zero criteria ⇒ unknown. `src/events/*` is unchanged.

Checks: `npm run typecheck` passed. Plain `npm test` hit read-only `node_modules/.vite-temp`; `TMPDIR=/tmp npx vitest run --configLoader runner` passed 108/108.

**VERDICT: CHANGES-REQUIRED**