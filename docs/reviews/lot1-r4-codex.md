## Findings

**SEVERITY: BLOCKER** — Array values still bypass the `toJSON`/accessor rejection in [src/events/canonical.ts](/home/antoinefa/src/track/src/events/canonical.ts:27). Repro: an array with own or inherited `toJSON` canonicalizes as `{"a":[1]}` but `JSON.stringify` persists `{"a":[2]}`. An own or inherited accessor at index `0` similarly hashes `[1]` and persists `[2]`. This bricks read-back validation with `content-hash`.

Fix: in the array branch, reject any functional `toJSON`, require every index to be an own data property (`Object.hasOwn` + descriptor check), and reject array index accessors/inherited indexed values before reading members.

**SEVERITY: BLOCKER** — Proxy objects can still pass the plain-object checks in [src/events/canonical.ts](/home/antoinefa/src/track/src/events/canonical.ts:41) and diverge at [src/events/canonical.ts](/home/antoinefa/src/track/src/events/canonical.ts:57). Repro: a proxy over `{x:0}` that reports plain descriptors but returns incrementing values canonicalizes as `{"x":2}` while `JSON.stringify` persists `{"x":3}`.

Fix: do not hash one live object traversal and persist another. Materialize a validated plain-data snapshot/string once and persist that exact materialized form, or add a proxy-rejecting materialization gate before canonicalization and persistence.

## Checks

Confirmed ordinary round-3 fixes: sparse arrays from `new Array`, `delete`, and `length` extension reject; null-prototype accessors reject; BigInt/boxed primitives reject; frozen JSON data accepts; integer-like key ordering is content-equivalent; symbol keys are ignored by both canonicalization and persistence.

`readHead` shape validation is improved as claimed for missing/unparseable/wrong-shape heads; I found no new permanent brick path beyond valid-shape forged heads, which remain fail-closed/recoverable by head deletion.

`npm run typecheck` passed. `npm test` could not run in this read-only sandbox: Vitest/Vite attempted writes under `node_modules/.vite-temp`; `--configLoader runner` then failed creating `/tmp` transform dirs.

**VERDICT: CHANGES-REQUIRED**