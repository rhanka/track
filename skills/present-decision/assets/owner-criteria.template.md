# Owner validation criteria — seed checklist

> Per-decision, not a global standard. Source the live criteria from the request, repo rules,
> prior owner decisions, existing track decisions/dossiers, and `track report --wp` attendus.
> Persist per decision/dossier; never edit repo rules unless the owner explicitly asks.

| criterion | source | covered by | gap |
|-----------|--------|------------|-----|
| **Reversibility** — is the change reversible, and is the rollback path stated? | standing rule | | |
| **Cross-repo owners** — are all affected repos / owners identified and consulted? | standing rule | | |
| **UAT before merge** — are the user-acceptance tests defined and green *before* merge? | standing rule | | |
| **Language** — discussion in FR; artifacts (code, SKILL.md, commits) in EN. | standing rule (FR-conv / EN-artifacts) | | |
| <decision-specific criterion> | | | |

## How to use
1. Copy this table into the dossier's **§7 Attendus**.
2. Drop seed rows that don't apply; add decision-specific rows.
3. Fill `covered by` from the dossier; any non-empty `gap` blocks "complete".
4. If criteria are genuinely uncertain, ask "what am I missing?" — otherwise ask for the concrete decision.
