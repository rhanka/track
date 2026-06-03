**1. Closure Of 9 Pinned Items**
1. Decision specialization & report exclusion: **CLOSED** — SPEC §2.5 + §7 collapse spec/acceptance to `n/a` and exclude decisions by default.
2. Recursion guard: **CLOSED** — SPEC §2.5 rejects Decision→Decision targets.
3. `done` ≠ outcome: **CLOSED** — SPEC §2.5 separates prep `realization=done` from settled `outcome ∈ {go,no-go}`.
4. outcome→terminal + deferred: **CLOSED/PARTIAL** — SPEC §2.6 chooses `no-go → rejected` and `deferred` keeps blocker open, but target-state edge cases are undefined.
5. Gate disposition: **PARTIAL** — SPEC §2.10 records dispositions, but does not define the Item↔Decision/gate linkage, multiple-decision handling, or completed-event payload.
6. Typed dossier: **CLOSED** — SPEC §2.7 fixes option IDs, joined Q&A, selected/recommended option, resulting spec change, and keeps `outcome` off dossier.
7. Extended event contract + emitted transitions: **PARTIAL** — SPEC §3 names the right events and explicit decision-caused transitions, but payloads, ordering, atomicity, and rev ownership are under-specified.
8. Blockers reuse mechanism, not semantics: **CLOSED** — SPEC §2.9 correctly keeps track product semantics local and h2a reuse post-MVP/mechanism-shaped.
9. BRANCH.md annotate-not-mutate: **CLOSED** — SPEC §5 says read-only sidecar; sentropic `lot-gate` mutates BRANCH.md and `branch-close` uses exact BRANCH.md body, so ownership claim is real.

**2. Internal Consistency**
- `acceptanceStatus` is not deterministic. SPEC §2.4 gives a partial precedence only for fail vs waiver. It does not say whether stale dominates fail/pass/waived, whether a stale fail is `stale` or `fail`, whether current fail plus stale pass is `fail` or `stale`, or what zero criteria means.
- Waivers are not typed enough. There is no waiver revocation/scope, no active-waiver rule, and no rule for waiver-after-fail. “live fail overrides waiver” contradicts a waiver being an exception unless “live/current” is formally defined.
- Test aggregation is wrong for real test evidence. `TestRun` has `criterionId` and `testRef`, but status says “criterion’s latest run”; multiple evidence links per criterion need all-current/all-pass or latest-per-test semantics.
- Event integrity is contradictory. SPEC §3 says `contentHash` chains canonical JSON including `prevHash`, but the event frame does not include `prevHash`. SPEC §4 then says concurrent merge is union ordered by `(at,id)` and “contentHash re-chained on read”, which either mutates append-only history or makes tamper detection ambiguous.
- h2a journal reuse claim is directionally right but not actually matched: h2a `contentHash` hashes the payload excluding `prevHash/sequence`; SPEC says hash includes prior linkage. Pick one.
- Fold determinism is not implementable as written. Per-aggregate `rev` conflicts under concurrent appends are not resolved. Two events with same aggregate/rev after a merge need a deterministic reject/conflict rule, not just `(at,id)` sorting.
- Decision side effects lack atomicity. `decision.outcome no-go` must append outcome, blocker resolution, and target `realization.transition → rejected`. If the process crashes mid-series, SPEC forbids silent inference but gives no transaction/batch/repair invariant.
- Deferred decisions are semantically half-terminal. SPEC says settled only `go|no-go`, but CLI allows setting `deferred`; it does not define allowed later transitions (`deferred → go`, `deferred → no-go`, `go → deferred`) or whether repeated outcome events supersede prior ones.
- `track blocker resolve <blockerId>` conflicts with “decision blocker resolves automatically only on `go|no-go`.” Validator must reject manual resolve for `kind:"decision"` blockers or there is a second source of truth.
- Decision blockers are not clearly opened. SPEC says pending decisions block targets, but no rule says `decision.created` emits `blocker.opened` per target. Without that, `deferred` cannot reliably keep targets AWAITED.
- BRANCH import idempotence is under-specified. `branch-id` has no source for root `BRANCH.md`; stable derived IDs conflict with `Item.id: Ulid` unless hash-to-ULID is specified; checkbox/status deltas are not mapped to realization transitions.
- “BRANCH.md import/annotate” does not define “annotate” beyond `.track` events. Fine as ownership, weak as behavior.

**3. PLAN Soundness**
- Lot order is broadly real for model core, but Lot 6 does **not** achieve Milestone 1 as stated. It imports BRANCH.md, but does not make `scope-check`/`lot-gate` read track, does not define checkbox→state mapping, and full CLI smoke is deferred to Lot 7.
- PLAN contradicts itself on CLI. Lot 6 delivers `track branch import`; Lot 7 delivers “full CLI surface.” A1 is a CLI acceptance test, so either Lot 6 needs CLI wiring or Lot 7 is part of Milestone 1.
- Lot 1 is too big while the event contract is unstable: event union, store, hash chain, deterministic merge, fold, snapshots, and all model types depend on unresolved integrity semantics.
- Lot 3 is missing tests for outcome transition legality and crash/partial-side-effect recovery. A5 alone is not enough.
- Lot 4 is too broad: acceptance computation, JUnit ingestion, prioritization, WSJF, and frozen dossier snapshots are independent. Stale detection is not testable until “current commit/env” is defined.
- Lot 5 tests A2, but report correctness depends on decision blocker auto-open/auto-resolve rules that are not fully specified.
- A1–A6 are not genuinely covered as gates yet: A4 is undermined by hash/rechain ambiguity; A6 by acceptance precedence ambiguity; A1 by missing idempotence keys/status mapping; A5 by missing decision-blocker open/manual-resolve rules.

**4. GO / NO-GO**
- **Lot 0: GO.** Scaffold can proceed.
- **Lot 1: NO-GO until minimal event-contract fixes land.**

Minimal blocking fixes only:
1. Define the event frame exactly: add `sequence`/`prevHash` or explicitly remove chaining fields; define `contentHash` inputs.
2. Choose one integrity/merge model: physical append chain, or deterministic sorted chain. Remove “re-chained on read” unless it is a read-only verification projection with exact rules.
3. Define per-aggregate `rev` conflict behavior after merge.
4. Define fold ordering and side-effect atomicity for multi-event commands, at least as a command batch or validator-repair invariant.