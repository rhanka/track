# Lot v2.3b-0 (write-serialization lock) — Opus 4.8 review

Adversarial Lot-1-grade review, paired with `docs/reviews/lot-v2.3b0-codex.md` (Codex, r1 **block** →
r2 **ship**). Opus originally surfaced the underlying bug during the M2b posture review: the unlocked
`appendCommand` critical section lets any concurrent writer permanently brick the log ("a race is not a
clean isError to the racer; it is permanent integrity poisoning that denies writes to every future
writer") — present in shipped 0.1.0–0.2.1, trivially triggerable, and the real trust boundary is **the
events file, not the process**.

## r1 verdict: ship-with-changes → all changes applied

1. **Steal TOCTOU (confirmed with a full interleaving walk):** waiter A pauses after judging a dead lock
   abandoned; B steals, acquires fresh; A's delayed pathname `unlinkSync` deletes B's LIVE lock; both end
   up in the critical section. Fix applied: **no stealing at all** (stronger than the suggested
   dead-PID-only stealing — pathname stealing removed at the root).
2. **Age-steal of a live holder is "when, not if":** append cost is super-linear (full re-parse + two
   O(n) re-SHA-256 `validate` passes per append ⇒ quadratic lifetime), so a long-lived store WILL cross
   any fixed `staleMs` with a healthy holder. Fix applied: no age path exists anymore.
3. **Unchecked `finally` release** could free a successor's lock. Fix applied: per-acquisition random
   token; release is ownership-gated.
4. **Test demands (all implemented):**
   - **Negative control** — deterministically persist the exact stale-prefix interleaving an unlocked
     race produces (correct contentHash, duplicate seq, stale prevHash) and assert `validate` fails with
     `prev-hash` + `aggregate-seq`, then assert the permanent `refusing to extend` DoS. (r1: the green
     concurrency test alone "could pass with no lock at all".)
   - **Same-aggregate contention** — r1 caught that `createItem` mints fresh ULIDs so every event had
     `seq=1` and the per-aggregate seq path was never exercised. Now: 4 processes × 8 `assessPriority`
     on ONE item ⇒ seq 1..33 strictly contiguous asserted.
   - **Barrier** for genuine overlap (now two-phase READY→GO per Codex r2), **non-reentrancy**, and
     **liveness** (a live holder in another process is never preempted; the waiter measurably enters
     only after release).

## r2 verdict: **ship**
- All r1 holes closed at the root; "mutual exclusion now rests entirely on O_EXCL atomicity, which is
  the correct primitive." No two-holder interleaving remains on same-host local FS.
- Release token-check window: human-error-only, sub-millisecond, rename-verify "collapses to the same
  terminal TOCTOU" — correct altitude as-is.
- Fail-closed orphan UX is "the correct trade for an integrity-DoS-prone store"; `flock(2)` (auto-release
  on death) noted in-code as the upgrade path if a native dep ever becomes acceptable.
- Tests verified **load-bearing, not theatrical** (negative control checked against `validate` logic;
  same-aggregate claim checked against `track.ts`).

## Outcome
220 tests green. Contract-neutral (event bytes/hash/seq/head untouched). Ships as 0.2.2. Known
out-of-scope follow-ups: reader torn-tail transient; write-channel lots (M2b decision).
