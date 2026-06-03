1. **Round-2 Fixes**
- F1: LANDED: `Decision` is `kind:decision`, linked, and `decided` is gone from axis 1; STILL-WEAK: as an `Item`, Decision now inherits dead spec/acceptance axes unless explicitly specialized.
- F2: LANDED: realization has `cancelled`/`rejected`, and `report` has `DROPPED`; STILL-WEAK: no rule distinguishes `cancelled` vs `rejected`.
- F3: LANDED: blockers are relations, not axis 4, and precedence is explicit; STILL-WEAK: “computed” contradicts stored `blocker.opened/resolved`, and h2a `blockage` is agent/session blockage, not product-item dependency semantics.
- F4: LANDED: `PriorityAssessment`, frozen `decisionEvaluation`, live `priority`, WSJF optional; STILL-WEAK: scheme registry/input schema still missing, but SPEC-level.
- F5: LANDED: BRANCH.md master, sidecar derived, `waived` exception, `done ≠ accepted`; STILL-WEAK: “frozen event contract” is now false because study/skip/dossier/waiver events are missing.

2. **New Problems**
- Recursive Decision-as-Item is unbounded: an orientation Decision can need its own orientation/commitment Decision, which can raise another decision blocker. Add an acyclic rule: Decisions cannot target Decisions by default, except explicit `meta`/`appeal` links with depth/authority rules.
- Decision axes are incoherent: if Decisions are Items, axis 1 asks whether the decision request is specified, axis 3 asks for test acceptance of a dossier. Mark spec/acceptance `n/a` for `kind:decision`, or stop saying Decision is a regular Item.
- “Prep work is realization” conflicts with `outcome`: dossier prep can be `done` while outcome remains `pending`. Either realization `done` means dossier complete only, or decision completion includes outcome. Current model mixes them.
- `deferred` is broken: blocker resolves when `outcome ≠ pending`, but `deferred` gives neither `go` nor `no-go`; target silently leaves AWAITED with no next state.
- `report` will be polluted: pending orientation Decisions appear in TO-DO while targets are AWAITED; no-go Decisions appear DONE while targets are DROPPED. Default `report` must exclude `kind:decision`, with a separate `--decisions` view.
- “Skippable” is not recordable: no `orientation.skipped` / `decision.skipped` / gate-disposition event, so skipped study is indistinguishable from forgotten study.
- Dossier is under-specified: parallel `questions[]`/`answers[]` can desync; `options[]` lack IDs; no `selectedOptionId`; no evidence/assumption/owner fields; no link from recommendation to outcome/spec changes.
- Two gates are not coherent yet: orientation is “usually” pre-spec and skippable; commitment is “typically” post-spec and optional by implication. There is no concrete gate policy: `required | skipped | not-applicable | completed`.

3. **Remaining Internal-Consistency Issues**
- Event contract says frozen, but open questions still cover round-trip, CI bridge, DONE policy, dependency default, and the new orientation lifecycle adds missing events.
- `decision.outcome` automatically causing target `realization.transition` contradicts append-only record semantics unless that transition is an explicit derived projection or an emitted event.
- `waived` is called an exception/decision, but there is no `acceptance.waived` or linked waiver Decision event.
- `decision` blocker resolved by “local manual flag” in MVP duplicates `decision.outcome`; pick one.
- `Dossier` text says it records outcome, but the schema puts `outcome` on `Decision`; avoid double source-of-truth.
- BRANCH.md “reads + annotates” risks mutating the master while claiming sidecar is derived; annotation ownership must be exact.

4. **NO-GO To SPEC As Written**
Minimal blocking changes:
- Specialize Decision items: axes `specification=n/a`, `acceptance=n/a`; default `report` excludes Decisions.
- Add recursion guard: no Decision targets Decision by default; enforce acyclic links.
- Add gate-disposition events/fields: orientation and commitment `required | skipped | not-applicable | completed`, with `deferred` semantics.
- Extend frozen event contract before SPEC: dossier revision, study/decision skipped, waiver exception, and explicit derived-vs-emitted target transitions.