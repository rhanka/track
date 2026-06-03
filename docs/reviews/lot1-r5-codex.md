## Findings

**SEVERITY: BLOCKER** — The “materialized” event is not inert at [src/events/store.ts:95](/home/antoinefa/src/track/src/events/store.ts:95). `materialize(core)` returns a null-proto core, but the store then re-wraps it with object spread into a normal `Object.prototype` event. A nested Proxy can install a non-idempotent `Object.prototype.toJSON` during materialization; candidate validation passes, then [appendAtomic](/home/antoinefa/src/track/src/events/store.ts:127) `JSON.stringify(event)` persists a different object.

Probe result:
`candidate agrees before write: true`
`persisted: {"persisted":"different"}`

Fix: keep the persisted `TrackEvent` prototype-inert too: construct it with `Object.assign(Object.create(null), materialized, frame)`, make `stripFrame` return a null-proto core, and make materialized arrays null-proto before hashing/persisting.

**SEVERITY: HIGH** — Round-4 direct array accessor defense is still missing in [src/events/canonical.ts:89](/home/antoinefa/src/track/src/events/canonical.ts:89). The array branch checks holes and `toJSON`, but not index descriptors; own/inherited accessors can make `canonicalize({a})` return different content across calls. `materialize` rejects own index accessors but still accepts inherited indexed values/accessors via `i in value`.

Fix: require every array index to be an own data property in both `materialize` and `canonicalString` (`Object.hasOwn` plus descriptor check), and reject inherited indexed values.

## Checks

`npm run typecheck` passed. `npm test` is blocked by the read-only sandbox: default Vitest tries to write `node_modules/.vite-temp`; runner/thread fallback ran 16 pure tests but the 33 temp-fixture tests failed on `EROFS mkdtemp`.

Static trace still shows the intended core hash, `prevHash`, aggregate seq, batch, head, and fold checks, but the prototype/toJSON hole breaks the materialize-once invariant.

**VERDICT: CHANGES-REQUIRED**