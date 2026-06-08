# Lot v2.3b-0 (write-serialization lock) — Codex (gpt-5.5 xhigh) review

Lot-1-grade review of the cross-process file lock added around `EventStore.appendCommand`'s
read→validate→compute→append→writeHead critical section. Paired with
`docs/reviews/lot-v2.3b0-opus.md` (Opus 4.8). The unlocked section was an **integrity-DoS shipped in
0.1.0–0.2.1**: two concurrent writers (CLI while MCP live, two `track-mcp`, a sidecar) compute the same
`prevHash`/`seq`, corrupt the single stream, and the fail-closed guard then refuses every future append.

## r1 verdict: **block** → all findings fixed

### blocker — steal-path TOCTOU (FIXED by removing stealing entirely)
v1 stole abandoned locks via *read → judge → `unlinkSync(lockPath)`*. Two waiters can both judge the
same dead lock abandoned; the slower waiter's pathname unlink then deletes the **winner's fresh lock**
→ both acquire → both run the critical section = the exact corruption the lock exists to prevent.
Pathname-based stealing is intrinsically racy ("not deleting a proven generation").

### blocker — age-based steal of a LIVE holder (FIXED by removing stealing entirely)
`staleMs=30s` stole even when `isAlive(pid)` was true. A merely slow legitimate append (append cost is
super-linear in log size: full `readAll` + two O(n) re-hashing `validate` passes; plus SIGSTOP, suspend,
debugger, slow disk) gets preempted → two holders; the slow holder's `finally` then unlinks the
successor's lock (cascade). "30s is not a correctness invariant."

### Fix shape adopted (= the review's own prescription)
**No automatic stealing of any kind.** Acquisition is solely `openSync(lockPath,'wx')` (kernel-atomic
O_EXCL); contention waits (`Atomics.wait` sync sleep) up to `timeoutMs` then throws **fail-closed with a
diagnosis** (holder pid/host/time + alive→"do not remove" / dead→"orphaned, safe to delete"), never
touching the lock. **Ownership-checked release**: a per-acquisition random token; `finally` unlinks only
its own generation. Boundary documented: same host, local FS (no NFS); `flock(2)` noted as the
orphan-free upgrade path if a native dep ever becomes acceptable.

## r2 verdict: **ship**
- Both holes closed for same-host/local-FS writers; "I do not see a normal interleaving that creates two
  simultaneous holders."
- Release read-then-unlink window: acceptable — only a human deleting a *held* lock at the exact instant
  reopens it; rename-to-unique "just moves the same external-intervention race".
- Fail-closed UX acceptable; optional (not required) hardening noted: hard-link acquisition to avoid an
  empty holder record if a writer crashes mid-acquire.
- Test improvement adopted: **two-phase READY→GO barrier** (children announce readiness; parent releases
  the whole fleet at once) instead of a fixed startup sleep.

## Also confirmed
- Frozen-contract neutrality: no change to event bytes/hash/seq/head — serialization only + a transient
  `events.jsonl.lock`.
- Crash-mid-append torn line stays detect-only (pre-existing SPEC posture; not worsened).
- Residual (out of scope, follow-up candidate): unlocked **readers** can transiently observe a torn
  trailing line during a large in-progress append (fail-closed throw, not corruption).

## Outcome
220 tests green (9 lock tests incl. 4-process same-aggregate barrier contention + the deterministic
negative control). Ships as 0.2.2.
