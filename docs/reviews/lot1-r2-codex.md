# Lot 1 Round 2 Review

Verification: `npm run typecheck` passed. Direct `npm test` is blocked by read-only Vite temp writes, but `TMPDIR=/tmp ./node_modules/.bin/vitest run --configLoader runner` ran 38/38 tests green.

## Findings

**MAJOR** — Canonicalization still accepts divergent plain values at [canonical.ts:24](/home/antoinefa/src/track/src/events/canonical.ts:24) and persistence still serializes the original object at [store.ts:112](/home/antoinefa/src/track/src/events/store.ts:112). A plain object or array with hidden `toJSON`, or an enumerable getter, can hash one value and persist another; `appendCommand` can write an event that immediately fails `validate`.  
Recommended fix: normalize once and persist the normalized JSON-safe event, or reject `toJSON`/accessors during deep validation before hashing.

**MAJOR** — `appendCommand` validates only the existing prefix at [store.ts:64](/home/antoinefa/src/track/src/events/store.ts:64), then writes the new candidate without validating `existing + events` at [store.ts:96](/home/antoinefa/src/track/src/events/store.ts:96). It can create an `aggregate-mismatch` log that `validate` then rejects.  
Recommended fix: validate the full candidate stream, with the candidate head, before `appendAtomic`.

**MAJOR** — `head.json` is written non-atomically at [head.ts:26](/home/antoinefa/src/track/src/events/head.ts:26), and `readHead` hard-fails on malformed JSON at [head.ts:20](/home/antoinefa/src/track/src/events/head.ts:20). A crash during head write can brick future appends even when `events.jsonl` is valid. Stale-head handling in [validate.ts:260](/home/antoinefa/src/track/src/events/validate.ts:260) correctly avoids false positives, but suffix truncation is detected only for the prefix actually recorded in a valid head.  
Recommended fix: write head via temp file + fsync + rename, or make corrupt/missing head an explicit rebuildable validation state.

**MINOR** — SPEC still has stale “payload-hash” wording in the §3 diagram at [SPEC.md:72](/home/antoinefa/src/track/docs/spec/SPEC.md:72), despite the text correctly saying event-core hash at [SPEC.md:215](/home/antoinefa/src/track/docs/spec/SPEC.md:215).  
Recommended fix: change the diagram label to core/content hash validation.

## Reframed Blocker

I agree a global per-event `streamSeq` is not required to solve suffix truncation. h2a’s `sequence` check at [/home/antoinefa/src/a2a-cli/packages/h2a/src/journal.ts:99](/home/antoinefa/src/a2a-cli/packages/h2a/src/journal.ts:99) also accepts a valid retained prefix after whole-suffix deletion. The right class of fix is an external head/manifest or durable git anchor, not a per-event counter. The current head anchor is directionally right, but its crash/corrupt-head behavior needs tightening before freeze.

Batch frame validation, short-write looping/fsync, aggregate-mismatch detection, `serializeState` deep-copy, and the frozen threat-model text otherwise landed.

**VERDICT: CHANGES-REQUIRED**