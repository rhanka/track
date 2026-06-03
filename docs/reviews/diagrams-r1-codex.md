INTENTION / Ecosystem boundary: PASS

INTENTION / Item lifecycle: PASS

SPEC / Realization state machine: FIX: replace one-line `note` with block note syntax, add rendered labels for `to-do`/`in-progress`, and label `rejected` edges as no-go-only:
`state "to-do" as to_do`; `state "in-progress" as in_progress`; `to_do --> rejected: no-go decision (cause=decisionId)`; `in_progress --> rejected: no-go decision (cause=decisionId)`; `note right of rejected` / `set only by a no-go decision (cause = decisionId)` / `end note`.

SPEC / Decision outcome machine: FIX: replace one-line `note` syntax with block notes, and add `state "no-go" as no_go` so the rendered state matches §2.6.

SPEC / Report bucket precedence: PASS

SPEC / Event flow + integrity: PASS

SPEC / Entities: PASS

PLAN / Lot dependency DAG: PASS

NO-GO on committing the diagrams.