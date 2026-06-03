## Findings

**SEVERITY: blocker** — `canonical.ts` still accepts values whose hash domain differs from the persisted `JSON.stringify` domain at [src/events/canonical.ts](/home/antoinefa/src/track/src/events/canonical.ts:22). Sparse arrays hash as invalid canonical text like `[ ,1]`/`[,1]`, but persist as `[null,1]`. Enumerable getters are also accepted at [src/events/canonical.ts](/home/antoinefa/src/track/src/events/canonical.ts:38); they can pass in-memory `validate([candidate])`, then stringify a different value on append. I reproduced both: candidate validation was clean, but the JSON-stringified/read-back event failed `content-hash`.
Recommended fix: reject sparse arrays (`i in array` for every index), reject accessor descriptors anywhere in the graph, and add tests for both. Keep rejecting `toJSON`; that is the right call for a record log unless the store persists a normalized clone.

**SEVERITY: minor** — `readHead` only treats JSON parse failure as malformed at [src/events/head.ts](/home/antoinefa/src/track/src/events/head.ts:39). Valid JSON with invalid head shape is cast as `Head`, then may silently disable anchoring (`{}`) or produce a false `head-mismatch`/`truncation` via [src/events/validate.ts](/home/antoinefa/src/track/src/events/validate.ts:257).
Recommended fix: parse to `unknown`; accept only `{ streamLength: nonnegative safe integer, lastContentHash: null|string }`, with `lastContentHash` required as a hash when `streamLength > 0`; otherwise return `null`.

## Fix Verification

The `__proto__` regression is fixed for JSON-reachable own keys, including nested keys; `constructor`/`prototype`, `-0`, unsafe JS numbers, arrays without holes, deep plain objects, and non-ASCII behave consistently with persistence. `toJSON` is rejected, which is correct for this contract.

`store.ts` now validates `existing + events` before append at [src/events/store.ts](/home/antoinefa/src/track/src/events/store.ts:98). That closes the round-2 cross-event aggregate/batch hole for ordinary JSON data. The remaining bypass is canonicalization accepting non-data JS shapes before persistence.

`head.ts` now catches torn JSON and uses same-directory temp + fsync + rename at [src/events/head.ts](/home/antoinefa/src/track/src/events/head.ts:46). Rename atomicity is fine for the relevant same-filesystem case.

SPEC §3’s diagram is fixed at [docs/spec/SPEC.md](/home/antoinefa/src/track/docs/spec/SPEC.md:72). The text matches the architecture, but the canonical domain should be tightened once accessors/sparse arrays are rejected.

Verification: `npm run typecheck` passed. `npm test` could not run in this read-only sandbox because Vitest/Vite tried to write temp files under `node_modules/.vite-temp` and `/tmp`.

**VERDICT: CHANGES-REQUIRED**