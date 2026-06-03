# Opus 4.8 — ROUND 2 review of INTENTION.en.md (2026-06-02)

## Prior 5 findings — ALL RESOLVED (verified against h2a code)
1. track↔h2a overlap + vocab collision: RESOLVED. Nuance: h2a `INTÉRÊT` = conflict-of-interest/trust posture (DEC-112; `h2a_declare_conflit_interet`), NOT product-interest → it's a *string/identifier* collision (DEC-112 reserves `interest`/`interests` in shared TS), not a concept clash. Keep as open question (done). Framing slightly inflated.
2. orthogonal axes + revocable computed acceptance: RESOLVED. lot-gate ref accurate.
3. append-only jsonl persistence: RESOLVED (aligned h2a lease-lock, real).
4. LLM proposes not decides: RESOLVED (REQ-054 citation accurate).
5. h2a-free MVP grounded in BRANCH.md: RESOLVED (lot-gate/branch-close are BRANCH.md skills — real integration point).

## New problems (decision-flow / blockers / prioritization)
- **P1 (central): "decided" on the SPECIFICATION axis conflates definition-maturity with go/no-go.** A spec can be fully defined yet decided NO. No slot for negative outcomes (rejected/cancelled/won't-fix). Realization axis has no terminal `rejected`/`cancelled` → a no-go item is stranded, `report` mis-buckets it as TO-DO forever. Fix: take go/no-go OFF axis 1 (axis 1 = pure definition: to-specify → specified, drop `decided`); model verdict as a `Decision`-kind Item linked to target; add terminal `cancelled`/`rejected` to realization.
- **P2: blockers are a covert 4th axis; report precedence undefined.** AWAITED is blocker-driven, overrides realization. Fix: blockers = annotations (not a state axis); define DONE vs AWAITED vs TO-DO precedence (e.g. done+open-blocker → ?).
- **P3: WSJF double-role temporal/identity ambiguity.** Decision-gate evaluation (frozen, inspectable, at decision-time) vs backlog sort key (live, inputs drift). `Item.priority?` "opaque blob" conflicts with "inspectable decision evidence." Fix: split `decisionEvaluation` (frozen snapshot, inspectable, part of decision record) from `priority` (live, re-rankable, may be opaque).
- **P4: three "decision" notions under-separated** — (i) axis-1 decision blocker, (ii) `Item kind:decision` ADR, (iii) h2a negotiation binding. State how they reference each other; in h2a-free MVP the decision blocker resolves via a local manual flag (anticipated-evolution #3 implicitly admits negotiation is too heavy for prep).
- **P5 (cosmetic): WSJF formula naming** non-standard vs SAFe (userBusinessValue + timeCriticality + riskReduction|opportunityEnablement). Flag for spec.

## Internal consistency
Mostly clean, far better than a single ladder. Largest gap: NO negative-terminal states anywhere (real backlogs ~20-40% negative-terminal). report precedence undefined. WSJF frozen-vs-live. Good: acceptance as revocable derived view, persistence, LLM-proposes, boundary A verbs (DELEGATED/DEGRADED/REUSED) accurate vs what h2a ships.

## Verdict: CONDITIONAL GO
Write the SPEC after pinning 4 minimal, model-level blocking changes in the INTENTION (must not defer): (1) negative terminals; (2) report precedence + blockers-as-annotations; (3) WSJF identity split (decisionEvaluation vs priority); (4) decision-blocker resolver + the 3 decision notions' references. Everything else non-blocking.
