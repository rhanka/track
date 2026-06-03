# Round-4 Freeze Confirmation — Lot 1 of `@sentropic/track`

**Gate:** `npm run typecheck` clean; `npm test` = **46/46 green** (6 files).

## Falsification campaign against the canonicalization invariant

Attacked empirically with throwaway probes over ~45 exotic constructions, plus the real end-to-end store path (`contentHashOf` → `JSON.stringify` → `JSON.parse` → `stripFrame` → `contentHashOf`).

**(A) Accept-consistency — 0 falsifications, 0 end-to-end bricks.** Every value `canonicalize` accepted re-hashes identically after the persist→reparse round-trip: plain/nested/deep objects, `Object.create(null)`, `Object.freeze`/`seal`, JSON-reachable `__proto__`/`constructor`/`prototype` own keys, integer-like key ordering, exotic string keys (`a"b`, `a\nb`, emoji), non-enumerable data/accessor props (invisible to both), Symbol keys (ignored by both), object-level `undefined` (dropped by both), exotic numbers (`-0`→`0`, `1e21`, `5e-324`, `2^53+1`).

> A probe initially flagged `{constructor:"hax",a:1}` as divergent — a comparator artifact (compared the sorted canonical string against unsorted `JSON.stringify`). The contract persists the raw object and re-canonicalizes on read, so insertion order is irrelevant; both orders yield identical hashes. No brick.

**(B) No false-reject of legitimate plain-JSON data — 0 found.** Every rejection maps to a value `JSON.stringify` would mutate or refuse (sparse holes via all four constructions, `undefined`/symbol/function members, `Date`/`Map`/class/boxed, `toJSON` methods, accessors, `BigInt`).

The invariant holds for everything I tested. (Codex, the parallel round-4 reviewer, additionally found that the **array** branch does not mirror the object branch's `toJSON`/accessor rejection, and that **Proxy** objects are undetectable and can diverge between the hash traversal and the persist traversal. Both are genuine; addressed by the materialize-once change — see lot1-r4-reconciliation.md.)

## Head shape validation

No false-negative/positive across 18 cases. A bad/corrupt/wrong-shape head degrades to "no head" (rebuildable), cannot brick the store; a forged valid-shape head with a wrong anchor is caught by `head-mismatch` and recovers on head deletion.

## Findings (Opus)

**[NIT]** `head.ts` accepts `lastContentHash:"sha256:"` (empty digest) and integers above `MAX_SAFE_INTEGER` — harmless (only ever yields a recoverable `head-mismatch`).

**[NIT — doc]** SPEC §3 worth a one-line note that `canonicalize` sorts keys so persisted JSONL insertion order is hash-irrelevant.

## Frozen-contract assessment

The two prior-round hash-domain defects are resolved. The event frame, `contentHash` domain, `prevHash` chain, per-aggregate seq, `cmd:{i,n}` batch, `validate`, head anchor, and pure `fold` mechanism are internally consistent and safe to build later lots on.

**VERDICT: FREEZE-OK**
