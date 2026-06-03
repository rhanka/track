**Findings**
SEVERITY: MINOR — [docs/spec/SPEC.md](/home/antoinefa/src/track/docs/spec/SPEC.md:215) still says persisted `JSON.stringify` form. Current code persists event lines via `canonicalize(e)` at [store.ts](/home/antoinefa/src/track/src/events/store.ts:129) and `head.json` via `canonicalize(head)` at [head.ts](/home/antoinefa/src/track/src/events/head.ts:65).  
Fix: update SPEC §3 wording to say persisted canonical JSON / `canonicalize(event)`, not `JSON.stringify`.  
Reachability: contract/docs only; no runtime input-surface exploit.

**Runtime Review**
No implementation break found. Hash path is `materialize(core)` then `contentHashOf`/`computeHash`/`canonicalize`; persist path is `canonicalize(event)`; readback validation is `JSON.parse(line)` then `contentHashOf(stripFrame(e))`. `canonicalize(JSON.parse(canonicalize(x)))` is a fixpoint for accepted JSON values under JS Number semantics, including `-0 -> 0`, exponent numbers, unicode, and `__proto__`.

`Object.prototype.toJSON` is ignored by canonicalization/materialization, and inherited array indices are rejected via `Object.hasOwn`. Store liveness is still one materialization of command input; validate/persist/head consume the inert event objects.

Regression trace looks intact: contentHash core domain, prevHash chain, per-aggregate seq, batch `cmd:{i,n}`, head anchor, fold determinism, and validate-before-append all remain present.

**Checks**
`npm run typecheck` passed. `npm test` could not run in this read-only session: default Vitest failed writing `node_modules/.vite-temp`, and `--configLoader runner` failed creating `/tmp/...`; no tests loaded. In-memory canonical/store-trace probes passed.

**VERDICT: CHANGES-REQUIRED**