**1. Hypothèses Fragiles Ou Fausses**

- « Système de record unique » + backends Jira/GitHub/VersionOne/Azure est incohérent sans modèle d’autorité par champ. Ces outils sont déjà des sources de vérité avec workflows, permissions, statuts, commentaires et locks. `Backend { read; write(delta) }` est une abstraction trop pauvre.
- `maturity: interet → intention → specified → accepted → delivered` confond état métier et signal calculé. Si `accepted` dépend de tests vivants, il peut régresser. Donc ce n’est pas une maturité stable.
- Le sidecar « frontmatter YAML vs `.track/*.jsonl` » n’est pas un détail. C’est le coeur : merge git, audit, append-only, conflits, signatures, idempotence, édition humaine.
- `Item.parent + kind` ne suffit pas à projeter Epic/Feature/UserStory/PI. Les backends imposent leurs hiérarchies, statuts, champs obligatoires et transitions.
- « Acceptation dérivée des tests » suppose que les critères sont exhaustivement et correctement liés à des tests. C’est faux dans les cas UAT manuel, non-fonctionnel, sécurité, perf, visuel, flaky, environnemental.
- « Plugin par host » suppose des capacités équivalentes Claude/Codex/Gemini. Faux : skills, MCP, permissions, formats, persistance et UX divergent.

**2. Frontières**

- BR-25 + skills ont déjà un mini-track opérationnel : `branch-init` crée `BRANCH.md` avec objectif, scope, lots, todo, UAT ; `scope-check` valide les frontières ; `lot-gate` exécute les tests et coche les gates ; `branch-close` fait de `BRANCH.md` le corps PR exact et source de vérité.
- Si `track` devient canonique, ces skills doivent appeler `track`. Si elles continuent à écrire `BRANCH.md`, `track` devient un parser redondant.
- h2a recouvre déjà une partie majeure : `ENGAGEMENT` = scope, charter, role bindings, controls, policies, success criteria, journal ; négociation, signatures, ledger, inbox/outbox, MCP, adapters host, `.h2a/` comme protocole de fichiers.
- h2a ne recouvre pas tout `track` : il ne fait pas backlog produit typé, bugs, critères structurés, mapping tests. Mais il recouvre clairement WorkPackage, journal, success criteria, evidence, consolidation.
- Mauvais découpage actuel : `track WorkPackage`, `coordinate Task`, `h2a ENGAGEMENT` sont trois conteneurs d’exécution/planning concurrents.
- La consolidation track-local ↔ Jira ↔ repos externes ne doit pas être « détenue » par h2a. h2a peut transporter/négocier/signaler ; la logique de merge domaine appartient à track.

**3. Pari Plugin Host + LLM-Mesh**

Sous-spécifié et dangereux.

Un LLM ne doit pas « piloter la cohérence » au sens système. Il peut proposer une réconciliation, pas décider la vérité. Il manque : canonical JSON, hash, revision vector, dry-run, merge policy déterministe, types de conflit, droits d’écriture, journal d’audit, approbation humaine, rollback.

`llm-mesh` est une boîte noire ici : identité, autorité, confidentialité, reproductibilité, drift modèle, coût, prompts, permissions outils, failure modes. Sans contrat formel, c’est un piège de gouvernance.

Le plugin multi-host est réaliste seulement si la surface est générée depuis un contrat unique CLI/MCP. Des skills écrites séparément par host vont diverger.

**4. Scope / YAGNI**

Trop large pour un MVP : lib + CLI + MCP + plugins multi-host + backends externes + projection agile + sync + llm-mesh + WorkPackage + UAT tests. C’est une plateforme, pas un MVP.

MVP strict : `docs-git`, schema typé, validate/query, import/export depuis `BRANCH.md`, un seul host via CLI, zéro backend externe.

Manquant mais bloquant : identité stable des items, format sidecar figé, versioning, audit log, stratégie de conflits, ownership par champ, modèle TestRun, migration BRANCH/PLAN, invariants de machine à états, contrat avec h2a.

**5. Séquencement**

CLI d’abord est bon seulement si elle remplace une douleur existante : valider/query `BRANCH.md` et produire un sidecar. Sinon vous construisez une CLI abstraite hors usage.

MCP avant modèle stable = churn. Plugins avant contrat CLI stable = divergence. `stp track` avant BR-42a stabilisé = couplage prématuré.

L’intégration h2a doit venir après : d’abord liens `trackRef` minimaux dans un engagement h2a, pas consolidation complète.

Le premier jalon doit être : « BRANCH.md existant → track sidecar → scope-check/lot-gate lisent track ». Pas Jira, pas llm-mesh.

**6. Acceptation Dérivée Des Tests**

Différenciateur intéressant, mais formulé de manière illusoire.

Des tests qui passent ne prouvent pas l’acceptation ; ils prouvent que des assertions passent dans un contexte donné. Il faut séparer :

- `acceptanceStatus` calculé : pass/fail/unknown/stale/waived.
- `maturity` métier : intention/specified/ratified/delivered.
- `TestRun` : commit, env, timestamp, runner, résultat, flaky policy.
- UAT manuel et waiver explicite.

`TestRef.lastResult` est insuffisant et dangereux : résultat périmé, mauvais commit, mauvais env, test renommé, test supprimé. Et « tous les tests passent » encourage des critères triviaux ou sans couverture.

**7. Verdict + Changements Imposés**

Verdict : intention non acceptable comme base de spec. Le besoin est réel, mais le design actuel gonfle `track` jusqu’à concurrencer BR-25, h2a et coordinate.

Changements imposés avant spec :

1. Redessiner les frontières : `track = Item / critères / preuves de test / statut calculé`; `h2a = engagement / négociation / journal / signatures / transport`; `coordinate = exécution Task`; skills = workflow. Supprimer ou dégrader `WorkPackage` en vue dérivée.
2. Figer le backend `docs-git` : format sidecar, IDs, versions, hashes, journal/audit, merge policy, ownership par champ. Interdire le LLM comme arbitre de cohérence.
3. Refaire l’acceptation : remplacer `lastResult` par `TestRun/TestEvidence`, séparer statut calculé et maturité, prévoir UAT manuel/waiver/stale/flaky, et brancher explicitement `lot-gate`/`branch-close`.