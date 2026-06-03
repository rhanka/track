# Opus 4.8 — review of SPEC + PLAN (2026-06-03). Verdict: CONDITIONAL GO.

## 9 pins
1 Decision specialized — CLOSED (§2.5/§2.4/§7). 2 Recursion guard — CLOSED (§2.5,A3). 3 done≠outcome — CLOSED (§2.5).
4 outcome→terminal+deferred — CLOSED (§2.6,A5). 5 gate disposition — CLOSED (§2.10). 6 dossier typed — CLOSED (§2.7).
7 event contract — PARTIAL (contract internally broken by Defect A). 8 blockers reuse — PARTIAL (overclaims h2a lineage; Defect A).
9 BRANCH.md never mutate — CLOSED & VERIFIED (lot-gate writes [x]; branch-close uses exact BRANCH.md as PR body then git rm → track MUST stay read-only).

## BLOCKING (must fix before Lot 1)
- **Defect A** — §3 says contentHash includes prevHash; §4 says merge re-chains by (at,id). Contradictory + not merge-stable + A4 ill-defined. h2a's journal.ts: contentHash=computeHash(payload) EXCLUDING prevHash/sequence; integrity = separate positional chain (verifyJournalChain: prevHash===prev.contentHash + monotonic sequence). FIX: hash payload-only; integrity = separate deterministic ordered chain; tamper = own-payload-hash mismatch.
- **Defect B** — (at,id) not deterministic/collision-free; folds depend on order (outcome after blocker.opened; fail after waived). FIX: ULID-ms `at` consistent with `id`; per-aggregate `rev` (not wall-clock) is transition-legality authority; state tie-break + cross-generator caveat.

## In-lane (fix before the relevant lot)
- C (Lot4): acceptanceStatus precedence under-specified — make ordered cascade fail(live,unwaived)→unknown→stale→waived→pass; fail-overrides-waiver per criterion; define waived×stale.
- D (Lot4): `stale` undefined — no "current commit/env" source. Define (HEAD? baseline? --commit arg).
- E (Lot3): `deferred` has no exit; the `outcome` transition machine is never drawn. Add transition table; re-deciding = new append-only decision.outcome event.
- F (Lot6): "stable derived IDs" collides with ULID id; key on stable lot SLUG not index (renumbering breaks idempotence); define identity-resolution/dedup algorithm.
- G (Lot6): branch parser contract vs real template — UAT are checkboxes INSIDE lots, gates nested. Need heading→Item.kind / nesting→parent/criterion mapping.
- Minor: desync `validate` rule undefined (give minimal: referenced file exists + title matches).

## PLAN
Ordering DAG correct; A1–A6 fully covered. BUT: Lot 4 oversized → split 4a acceptance / 4b priority (independent). Milestone 1 silently dropped INTENTION's "scope-check/lot-gate CAN READ track" half — flag the scope cut explicitly. `outcome` transition machine has no deliverable home (Lot 3). Golden fixture should assert fold determinism under SHUFFLED event order (the property Defects A/B threaten).

## GO
Lot 0 (scaffold) can start now. Lot 1 BLOCKED until Defects A & B fixed (small prose fixes, fatal if left to implementer). C–G fixable in-lane.
