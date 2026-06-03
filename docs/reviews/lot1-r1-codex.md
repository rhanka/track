**Findings**

1. **BLOCKER** — Hash contract is internally inconsistent: SPEC/PLAN freeze `contentHash=sha256(canonicalJSON(payload))` as nested payload-only, but implementation hashes `EventCore`.
   Refs: [docs/spec/SPEC.md:212](/home/antoinefa/src/track/docs/spec/SPEC.md:212), [docs/spec/SPEC.md:214](/home/antoinefa/src/track/docs/spec/SPEC.md:214), [docs/plan/PLAN.md:23](/home/antoinefa/src/track/docs/plan/PLAN.md:23), [src/events/frame.ts:5](/home/antoinefa/src/track/src/events/frame.ts:5).
   Fix: keep the implementation choice, but amend SPEC/PLAN before freeze: h2a “payload” means the stripped non-frame journal entry, not nested `body`. Add tests proving tamper of `type`, `aggregateId`, `by`, `cmdId/cmd` is detected. Payload-only would be weaker and less h2a-faithful.

2. **MAJOR** — `cmd:{i,n}` is a sound fix for dropped trailing batch members, but validation accepts malformed batch frames.
   Refs: [src/events/validate.ts:110](/home/antoinefa/src/track/src/events/validate.ts:110), [src/events/validate.ts:112](/home/antoinefa/src/track/src/events/validate.ts:112), [src/events/validate.ts:146](/home/antoinefa/src/track/src/events/validate.ts:146).
   Issue: `declaredN` is overwritten by the last member, so inconsistent `cmd.n` can pass if the last value is plausible; it also does not enforce integer/non-negative `i`, positive integer `n`, `i < n`, or `cmd` iff `cmdId`.
   Fix: validate every member’s `cmd.n` equals the same `n`, every `i` is a unique integer in `[0,n)`, and reject `cmd` without `cmdId`. Document `cmd` in SPEC §3. Alternative: command header/commit event with expected event ids/hashes, but heavier.

3. **MAJOR** — “all-or-nothing atomic batch” is overstated for crash/torn-write behavior.
   Refs: [src/events/store.ts:85](/home/antoinefa/src/track/src/events/store.ts:85), [src/events/store.ts:91](/home/antoinefa/src/track/src/events/store.ts:91), [src/events/store.ts:92](/home/antoinefa/src/track/src/events/store.ts:92), [src/events/store.ts:35](/home/antoinefa/src/track/src/events/store.ts:35).
   Issue: one `writeSync` can be partial, its return value is ignored, directory entries are not fsync’d, and a torn JSONL line makes `readAll()` throw before `validate` can report/repair.
   Fix: loop until all bytes are written, fsync parent dirs on create, and either downgrade the contract to “torn writes are detected as malformed log” or add a batch commit/checksum marker so `validate` can identify and truncate/repair an incomplete tail batch.

4. **MAJOR** — Canonicalization accepts non-plain objects that can hash differently than persisted JSON.
   Refs: [src/events/canonical.ts:24](/home/antoinefa/src/track/src/events/canonical.ts:24), [src/events/store.ts:88](/home/antoinefa/src/track/src/events/store.ts:88).
   Issue: `Date` canonicalizes as `{}` via `Object.keys`, but `JSON.stringify(event)` persists it as an ISO string; later validation will fail on a store-written event. Same class of bug exists for custom `toJSON`.
   Fix: enforce JSON-only plain values before hashing, or JSON-roundtrip/normalize before both hashing and writing. Add canonical tests for `undefined`, arrays, `null`, non-finite numbers, `Date`, `-0`, and Unicode normalization expectations.

5. **MAJOR** — Integrity limits are not frozen explicitly.
   Refs: [src/events/validate.ts:45](/home/antoinefa/src/track/src/events/validate.ts:45), [src/events/validate.ts:52](/home/antoinefa/src/track/src/events/validate.ts:52), [src/events/validate.ts:64](/home/antoinefa/src/track/src/events/validate.ts:64), [src/events/validate.ts:75](/home/antoinefa/src/track/src/events/validate.ts:75), [src/events/validate.ts:93](/home/antoinefa/src/track/src/events/validate.ts:93).
   Undetected: empty stream; valid single event; deletion of a whole suffix or non-batch tail event; deletion of a whole trailing batch; tail event rewrite with recomputed `contentHash`; earlier event rewrite if the next `prevHash` is adjusted; seq renumbering after a repaired rewrite; SHA-256 collision.
   Fix: document this as the exact threat model, or add an anchored head/manifest containing stream length + final hash, preferably committed/signed.

6. **MAJOR** — `fold` is deterministic, but it silently folds invalid seq streams.
   Refs: [src/state/fold.ts:24](/home/antoinefa/src/track/src/state/fold.ts:24), [src/state/fold.ts:37](/home/antoinefa/src/track/src/state/fold.ts:37), [src/events/store.ts:59](/home/antoinefa/src/track/src/events/store.ts:59).
   Issue: `fold` does not enforce exact per-aggregate `seq`; `appendCommand` rereads the log, but does not validate before deriving state. Whole-log reread is not a correctness risk under true single-writer; extending a parseable invalid log is.
   Fix: make `fold` throw on non-contiguous seq, or freeze a hard `fold(validatedEvents)` precondition and ensure append/transition paths validate before folding.

7. **MINOR** — Aggregate identity is keyed only by `aggregateId`, not `(aggregate, aggregateId)`.
   Refs: [src/events/store.ts:63](/home/antoinefa/src/track/src/events/store.ts:63), [src/events/validate.ts:75](/home/antoinefa/src/track/src/events/validate.ts:75), [src/state/fold.ts:28](/home/antoinefa/src/track/src/state/fold.ts:28), [src/state/snapshot.ts:27](/home/antoinefa/src/track/src/state/snapshot.ts:27).
   Fix: either define aggregate IDs as globally unique and validate that, or key seq/fold/snapshot maps by `${aggregate}:${aggregateId}` before freeze.

Verification: `npm run typecheck` exited 0. `npm test` could not start because the read-only sandbox blocked Vite writing `node_modules/.vite-temp`.

**VERDICT: CHANGES-REQUIRED**