# Opus 4.8 — ROUND 3 review of INTENTION.en.md (2026-06-03)

## Round-2 fixes: ALL LANDED & coherent (verified vs h2a code)
- F1 decisions = first-class linked `kind:decision` items, `decided` removed from axis 1. LANDED.
- F2 negative terminals `cancelled`/`rejected` + DROPPED bucket. LANDED.
- F3 blockers = append-only relations, explicit report precedence; `resolutionRule` field present but DEFAULT punted to Open Q5. LANDED (close default in SPEC).
- F4 versioned `PriorityAssessment`; live `priority` vs frozen `decisionEvaluation`; WSJF one scheme, not opaque/hardcoded. LANDED (strong).
- F5 frozen event contract; BRANCH.md stays master, sidecar = derived index; `waived` = exception not test result; `done ≠ accepted`. LANDED (strong).
Verified good: EVO-9 INTÉRÉT = trust concept (DECISIONS.md:1973), distinct; blockage reuse maps to real h2a raise→list→resolve; REQ-054 backs "LLM proposes"; BRANCH.md-master correct (lot-gate mutates checkboxes, branch-close ships exact body).

## New problems (study/orientation + Decision-as-Item)
- (2a) Recursion bounded in practice but base case never stated; `targets: ItemId[]` untyped → a Decision could target another Decision → representable deadlock.
- (2b) A `kind:decision` item has DEAD axis-1 (spec) and axis-3 (acceptance — no test passes a brainstorm); empty AcceptanceCriterion → spurious `unknown`.
- (2c) `report` iterates Items incl. Decisions → a `pending` orientation Decision shows in TO-DO (noise); a `no-go` Decision `done` lands DONE while its target lands DROPPED (same event = win+loss). No scoping by kind.
- (2d) "Skippable" hand-waved: no skip event/marker in the frozen event contract → skipped study indistinguishable from forgotten; unqueryable.
- (2e) `Dossier` under-typed: `options[]`/`answers[]` untyped, `questions[]`/`answers[]` parallel arrays (desync), chosen option not machine-linked to outcome/spec → defeats "queryable".

## Remaining consistency
- `outcome no-go → cancelled|rejected` is 1→2 with no selector; `deferred` has no realization consequence + auto-resolves the blocker (`deferred ≠ pending`) letting target proceed though nothing decided.
- `waived` vs regressing red test: precedence undefined.
- DONE acceptance-pass toggle unnamed (Open Q4).

## Verdict: CONDITIONAL GO — do NOT re-iterate INTENTION; proceed to SPEC, which MUST close:
1. Bound recursion: a `Decision` MUST NOT target another `Decision` (or define termination + cycle rejection).
2. Decision-as-Item axis semantics: spec + acceptance axes are n/a/collapsed for kind:decision.
3. Scope `report` to `kind != decision` by default (+ `--decisions` flag); define no-go-done vs DROPPED-target.
4. Make "skipped" first-class: skip marker/event so absence-of-study is queryable.
5. Map `outcome → terminal` (cancelled vs rejected) + define `deferred` (stop auto-resolving the blocker).
Minor (dossier typing, waived-vs-red, DONE toggle name) ride the Open Questions list.
