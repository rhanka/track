# Lot A (deps/RACI/scope/engagementRef) — Opus 4.8 review

Adversarial Lot-1-grade review, paired with `docs/reviews/lot-A-deps-raci-codex.md`. **Verdict:
ship-with-changes** → applied. Both reviewers independently identified the SAME single substantive gap.

## Confirmed sound (verified against canonical/fold/blocker-status)
- **Additivity:** payload/enum-only on existing event types; old events hash byte-identically
  (`canonicalize` drops undefined); `scope` emitted only when `'extra'`. No new event type/seq/prevHash/hash.
- **`ref?` ripple — complete:** every reader of `blocker.ref` (fold `isOpen` linked-done; blocker-status
  linked-accepted; the `kind==='decision'` equality) is guarded; an extra blocker (ref undefined, rule
  `manual`) cannot reach a deref. Intra `linked-*` projections unaffected.
- **openBlocker guards:** all four extra-combinations covered + tested; intra/decision unchanged. No
  write-path bypass.
- **RACI / ingest / CLI / scope:** D6 cleanly resolved (decision `accountable` = sponsor; no dangling
  `sponsor` in code); ingest fail-closed split correct; CLI flags + USAGE correct; cut list respected.

## The gap (both reviewers) — FIXED
The design (`M3-deps-raci-DESIGN.md` §risk) names a **fold/validate-time fail-closed assertion** as the
SINGLE mitigation for the relaxed `openBlocker` ref-check; it was **not implemented** (only the write-time
guard). A self-consistent (valid-hash) extra blocker from a future writer / the Lot C bridge / a direct
`appendCommand` could fold through `fold.ts` and dereference a foreign `ref`. **Fix:** `validateBlockerScope`
in `validate.ts` (a `blocker-scope` finding) — and per Codex, the FULL invariant (decision/intra require
`ref`; extra requires no-ref + non-empty `engagementRef` + manual-only). Regression-tested with 5 malformed
cases isolating the finding on a valid frame.

## Other applied
- **Report surfacing of `accountable`** (Opus + Codex flagged the design's "fold/report" — report was
  missing): `ReportRow.accountable?`/`engagementRef?` + `DecisionRow.accountable?`. + the highest-value
  missing test (an open extra blocker keeps its target AWAITED in the report; resolve clears it) +
  decision.accountable ingest round-trip.

## Outcome
297 tests green; typecheck + build clean. Frozen-contract neutral. Ships as 0.5.0.
