# Lot 1 — review round 3 reconciliation (Codex gpt-5.5 xhigh + Opus 4.8)

Round 3 **split**: Opus 4.8 returned **FREEZE-OK** (attacked the hash domain hardest, found no blocker/major); Codex gpt-5.5 returned **CHANGES-REQUIRED**, having found and reproduced a class Opus missed.

## Independent adjudication

Codex's blocker is **valid**. Verified independently:
- **Sparse arrays.** `Array.prototype.map` skips holes, so `[,1]` canonicalized to `[,1]`, but `JSON.stringify([,1])` persists `[null,1]`. The event hashes one way and persists another → it fails its own `validate` on read-back and bricks the store. Programmatic-only (JSON.parse never yields holes), but a system-of-record's canonicalizer must never silently emit a divergent form.
- **Accessor (getter) properties.** A non-idempotent or side-effecting getter can be read at hash time and re-read at persist time with a different result. Programmatic-only and adversarial, but cheaply closed.

Opus's FREEZE-OK was correct for every vector it tested; it simply did not test sparse arrays/accessors. This split is the intended value of diverse-model double review.

## Resolution (applied, gate green 46/46)

`canonical.ts` now accepts **exactly the plain-JSON-data domain**, making `hash ≡ persist` a *provable invariant* (the divergence class is empty by construction). It fail-loud rejects, before any write: non-finite numbers, non-plain objects (`Date`/`Map`/class), `toJSON`-bearing objects, accessor (getter/setter) properties, sparse-array holes; and (faithful to h2a) `undefined` array members. Tests added: sparse-array rejected, accessor rejected.

`head.ts` `readHead` now validates **shape** (`streamLength` a non-negative integer; `lastContentHash` `null` iff `streamLength==0`, else a `sha256:` string), returning `null` otherwise (Codex MINOR) — a well-formed-JSON wrong-shape head no longer silently disables anchoring or raises a false truncation. Test added.

SPEC §3 canonicalization sentence updated to list the full rejection policy (Opus NITs on `toJSON`/array-`undefined` doc completeness).

## Deferred (acknowledged, not blocking — both reviewers)

- Double full-stream validation per append is O(n²) over the stream lifetime (perf only; single-writer local n is small). Post-MVP: validate the prefix once + incrementally check the appended tail.
- No automated repair verb after a fail-closed tamper/truncation (manual head-delete recovery); Lot 7 / post-MVP.

→ Round-4 confirmation requested for a unanimous FREEZE-OK before freezing.
