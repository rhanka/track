# Lot 1 — review round 2 reconciliation (Codex gpt-5.5 xhigh + Opus 4.8)

Both round-2 reviewers confirmed the round-1 fixes landed and blessed the integrity **architecture** (head anchor + frozen threat model; "Track is stronger than h2a on truncation"). Both returned **CHANGES-REQUIRED** for residual plumbing defects in the code the round-1 fixes touched. All accepted; applied; gate green at **43/43**.

| # | Finding | Reviewer(s) | Resolution |
|---|---|---|---|
| 1 | **`canonicalize` hash≠persist divergence on a *plain* object** — a JSON-reachable `__proto__` own key vanishes from the hash (silent A4 tamper bypass, verified e2e); a `toJSON`/accessor diverges. | Opus MAJOR-1 (`__proto__`), Codex MAJOR-1 (`toJSON`) | `canonical.ts` rewritten to **emit the canonical string directly** (no object reconstruction) — `source[k]` is read for every own key incl. `__proto__`, hashed exactly as `JSON.stringify` persists it. `toJSON`-bearing objects are **rejected**. Tests: `__proto__` covered + on-disk tamper of a `__proto__` key now caught; `toJSON` rejected. |
| 2 | **`appendCommand` validated only the existing prefix**, then wrote the new events without validating `existing+events` → could persist a log that `validate` rejects (e.g. a batch introducing an aggregate-mismatch). | Codex MAJOR-2 | `store.ts` now `validate`s the **full candidate stream** before `appendAtomic`; throws "command would produce an invalid log" otherwise. Test: a batch reusing an aggregateId under two types is rejected. |
| 3 | **`head.json` non-atomic write + `readHead` hard-fails on malformed JSON** → a torn head bricks all future appends (new corruption mode the anchor introduced). | Codex MAJOR-3, Opus MAJOR-2 | `readHead` degrades to `null` on missing **or malformed** head (it is rebuildable); `writeHead` is **atomic** (temp file + `fsync` + `rename`). Test: a corrupt `head.json` is tolerated and the next append succeeds. |
| 4 | SPEC §3 flow-diagram label still said `payload-hash`. | both (MINOR) | `SPEC.md:72` → `core-hash + prevHash + seq + head`. |

## Reframed BLOCKER — closed

Both reviewers **agreed** a global per-event `streamSeq` is not required and would not detect suffix truncation (h2a's `verifyJournalChain` accepts a truncated prefix identically). The head anchor + frozen threat model is the correct fix and is in place.

## Deferred (acknowledged, post-MVP)

- No repair verb after a fail-closed truncation/tamper detection (tolerant repair = Lot 7 / post-MVP).
- Non-enumerable `toJSON` is now rejected; full rewrite-with-rechain and SHA-256 collisions remain out of the single-writer local threat model (git layer), as frozen in SPEC §3.

→ Round-3 review requested to confirm closure of the (twice-touched) frozen hash domain before freeze.
