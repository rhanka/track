1. **Prior Findings**
- **RESOLVED:** typed backlog vs h2a contract stack is now mostly separated; `WorkPackage` is degraded to refs; LLM coherence is explicitly proposal-only; MVP is h2a-free and BRANCH.md-anchored.
- **STILL WEAK:** “Specification” still collides conceptually with h2a `SPECIFICATION`; persistence says “frozen append-only jsonl” but keeps “local journal vs h2a journal” open; `blockage_raise/resolve` is claimed though the checked h2a surface exposes escalation/negotiation, not blocker verbs.

2. **New Problems**
- WSJF is overloaded: it is both formal decision evaluation and backlog sort key. That is only coherent if WSJF is a versioned `PriorityAssessment` event reused by two projections. As written, optional prioritization contradicts the hardcoded `evaluation(WSJF)` stage.
- `Item.priority? = opaque blob` undermines queryable/diffable/deterministic merge. Opaque plugin state cannot safely drive report ordering without `schemeId`, `schemeVersion`, input schema, computed score/order, timestamp, and deterministic tie-breakers.
- The decision sub-flow leaks realization into definition. `decision-prep` is work: producing a dossier, Q&A, alternatives. That belongs to a decision item’s realization/task, while the blocked item’s specification axis should only reflect whether the request is defined/decided.
- `Item kind: decision` and “decision blocker on an item” are conflated. A decision item can itself be to-do/in-progress/done, while a normal item can await that decision. Those need separate identities and links.
- Blockers are a fourth axis unless defined as computed open relations. Current model says “three axes + blockers” but report treats blockers as a bucket-level state overriding realization.
- AWAITED conflicts with DONE/TO-DO. If an item is `in-progress` and blocked, is it TO-DO or AWAITED? If it is `done` but dependency remains open, is it DONE or AWAITED? Bucket precedence or non-exclusive buckets are required.
- Dependency blockers need resolution semantics. Does a dependency clear on linked item `done`, acceptance `pass`, decision `decided`, or manual unblock? Current text does not say.

3. **Internal Consistency**
- The model is close, but it mixes axes, workflow events, blocker relations, and report buckets as if they were the same kind of state.
- Acceptance is computed/revocable, but `waived` is not a test status; it is a decision/exception that affects acceptance computation.
- `DONE: realization done optionally and acceptance pass` weakens the stated purpose: acceptance criteria tied to test evidence. Keep realization done distinct from accepted/pass.
- h2a-free MVP is credible, but the document still imports h2a-shaped blocker/journal assumptions before the local jsonl/event contract is fixed.
- BRANCH.md grounding is under-specified: current `lot-gate` mutates BRANCH.md checkboxes and `branch-close` requires exact BRANCH.md PR body. Track must either preserve BRANCH.md as source of truth for MVP or explicitly migrate those skills.

4. **NO-GO To SPEC**
Minimal blocking changes:
- Replace decision sub-flow with `DecisionRequest`/`DecisionItem` events: prep work is realization; outcome closes the blocker and updates specification.
- Define blockers as append-only, computed open relations with owner, target, reason, resolution rule, and report precedence.
- Split WSJF/prioritization into versioned assessments plus selected report sort scheme; remove hardcoded WSJF from axis 1 unless the scheme is active.
- Freeze the MVP local jsonl event contract and BRANCH.md round-trip before writing SPEC.