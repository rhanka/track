# Lot 1 — review round 5 reconciliation (Codex gpt-5.5 xhigh + Opus 4.8)

Round 5 **split**: Opus 4.8 returned **FREEZE-OK** (full code trace + ~empirical falsification of materialize-once: live input read exactly once, no second traversal); Codex returned **CHANGES-REQUIRED** with two in-process prototype-pollution vectors.

## Independent adjudication

Codex's findings are **structurally valid** (and out of the realistic input threat model — both require a malicious `Proxy`/prototype pollution injected *programmatically in-process*, which cannot arise from CLI/JSON input and would imply the attacker already controls the process):
1. The persisted `event` wrapper is `Object.prototype`-based, so `JSON.stringify(event)` would honour an inherited (polluted) `toJSON` — diverging from the hash.
2. The array branch used `i in value`, which is true for *inherited* indices (polluted `Array.prototype`), not just own holes.

Rather than patch these two, I closed the class **by identity**:

## Resolution — hash ≡ persist by identity (applied, gate green 53/53)

- **The store now persists via `canonicalize(event)`** (`store.ts` `appendAtomic`) — the SAME serializer used to compute `contentHash` (`sha256(canonicalize(materializedCore))`). Persisted bytes and hashed bytes are produced by one function over one inert snapshot, so they cannot diverge for *any* input. `head.json` is written via `canonicalize` too.
- **`canonicalize`/`materialize` inspect own properties only** (`Object.hasOwn`, own descriptors; `toJSON` checked with `Object.hasOwn`), so a polluted `Object.prototype`/`Array.prototype` cannot affect hashing, array-index enumeration, or `toJSON` detection.

New tests: inherited `toJSON` ignored; inherited array index rejected (`Object.hasOwn`); each event persisted as canonical sorted-key JSON (= the hash serializer); end-to-end append+validate correct **under live `Object.prototype.toJSON` pollution**.

## Convergence posture

The canonicalization invariant is now **closed by identity**, not by enumerating exotic shapes: there is one traversal of the live input (`materialize`), and the one serializer (`canonicalize`) computes both the hash and the persisted bytes over the resulting inert snapshot. The residual vectors Codex raises are in-process-API-abuse, unreachable from track's input surface (CLI/JSON = inert data). Round 6 reviews the new `canonicalize`-persistence change (don't freeze on unreviewed contract code); it is the bounded final adversarial round.
