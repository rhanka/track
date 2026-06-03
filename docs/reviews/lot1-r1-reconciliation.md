# Lot 1 — review round 1 reconciliation (Codex gpt-5.5 xhigh + Opus 4.8)

Both reviewers returned **CHANGES-REQUIRED**. This note records what was accepted, what was reframed, and the resulting change set applied before re-review.

## Accepted (consensus → fixed)

| # | Finding (reviewer) | Resolution |
|---|---|---|
| 1 | **Canonicalization persist/hash divergence** — a `Date` / non-plain object hashes as `{}` but `JSON.stringify` persists it as a string, so the event fails its own `validate` (Codex MAJOR-4). | `canonical.ts` now **rejects non-plain objects** (prototype must be `Object.prototype` or `null`) — fail-loud. Hardening beyond h2a, justified: track payloads are command-supplied. + canonical edge-case tests. |
| 2 | **Batch frame validation too weak** — `declaredN` overwritten by last member; no check of consistent `n`, unique `i ∈ [0,n)`, `cmd` iff `cmdId` (both). | `validate.ts` `validateBatches` now enforces: `cmd` iff `cmdId`; all members share the same integer `n>0`; every `i` a unique integer in `[0,n)`; count `== n`; contiguous. New `batch-frame` finding kind. |
| 3 | **Atomicity overstated / short write** — single `writeSync` may write partially; return ignored (both). | `store.ts` loops `writeSync` until all bytes flushed, then `fsync`. Comment downgraded to the honest guarantee + documented recovery (a torn trailing line is reported by `validate`, not silently skipped). |
| 4 | **SPEC drift** — §3 still says `PAYLOAD ONLY`, no `cmd` (both). | `SPEC.md` §3 frame + diagram amended: `contentHash` = hash of the event core (all fields except `seq/prevHash/contentHash`); `cmd?:{i,n}` added; **threat model frozen explicitly** (what `validate` detects vs not). `PLAN.md` Lot 1 note updated. |
| 5 | **Extending an invalid log** — `appendCommand` re-reads but does not validate; `fold` folds invalid seq silently (Codex MAJOR-6, Opus MAJOR-3). | `appendCommand` now **`validate`s the existing log and throws if invalid** (fail-closed). `fold` documents its precondition (validated stream). Next per-aggregate seq derived from `max(seq)+1`, aligned with `validate`'s authority. |
| 6 | **Aggregate identity keyed by `aggregateId` only** (Codex MINOR-7). | `validate` adds an `aggregate-mismatch` finding if one `aggregateId` ever appears under two `aggregate` types (invariant: `aggregateId` is a globally-unique ULID). Map keys kept as `aggregateId`. |
| 7 | Degenerate-case + frame-tamper tests missing (both). | Added: empty stream, single event, tamper of `type`/`aggregateId`/`by`/`cmd` detected, canonical edge cases, batch-frame violations, truncation via head anchor. |
| 8 | `serializeState` returns live projection refs (Opus MINOR-3). | `serializeState` deep-copies `history`. |

## Reframed (reviewer divergence → my call)

**Tail / whole-suffix truncation undetectability.** Opus rated this a **BLOCKER**, claiming track is "strictly weaker than h2a" and that a global `streamSeq` would "restore h2a parity and make truncation detectable." This is **inaccurate**: h2a's `verifyJournalChain` has the *same* limitation — dropping the trailing entries leaves a global `sequence` of `0..k-1` perfectly contiguous, so a global counter alone does **not** detect suffix truncation. Codex framed the same facts correctly as MAJOR-5: *document the threat model, and/or add an anchored head/manifest (stream length + final hash, preferably committed/signed).*

**Resolution (Codex's framing):**
1. **Threat model frozen in SPEC §3** — `validate(events)` detects: content tamper, reorder, insertion, mid-stream deletion, partial batch, aggregate-type mismatch. It does **not**, from the log array alone, detect: suffix truncation, a full rewrite-with-rechain, or SHA-256 collisions.
2. **Head anchor added** — `.track/head.json = { streamLength, lastContentHash }`, written after each append (non-authoritative, like snapshots). `validate(events, head?)` uses it to detect suffix **truncation** and head-position tamper. The log remains the source of truth; durable anchoring is additionally provided by the `docs-git` backend (the committed `events.jsonl`).

No global per-event `streamSeq` field was added: it would not close the truncation gap, and the positional `prevHash` chain already detects insertion/reorder/mid-deletion equivalently to h2a's global `sequence`.

## Deferred (documented, not changed for MVP)

- `readAll` stays **fail-closed** on a malformed line (refuses to extend a corrupt log) — safe default for a system-of-record; a tolerant repair path is post-MVP.
- Full rewrite-with-rechain and hash collisions are out of the single-writer local threat model (mitigated by the git layer); frozen as such in SPEC §3.
