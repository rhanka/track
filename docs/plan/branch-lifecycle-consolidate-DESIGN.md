# DESIGN — Skill branch-lifecycle track-aware + `consolidate` au merge (Lot B)

**Status:** draft pour pair-consensus Codex 5.5xhigh + Opus 4.8max. Motivé par l'incident graphify
(2026-06-29) : un squash-merge GitHub d'une branche `.track` a JETÉ 18 reparentages POURTANT commités →
`track audit` a révélé 18 orphelins ; réparé par `restructure apply`. Renforce le follow-on WP1.

## Problème (grounded)
- `track consolidate --items <id,id> --commit <mergeCommit>` EXISTE déjà (cli/index.ts:810) : le « HEAL
  squash/rebase » — pour chaque done item, append `realization.anchored{reason:'consolidate'}` + re-stamp
  les runs pass au merge commit (acceptance redevient fraîche post-rebase). Predicate d'éligibilité pur
  (track.ts:136).
- MAIS deux trous opérationnels :
  1. **Drift de structure non géré** : un squash/rebase qui résout `.track` vers UNE version jette les
     events appendés de la branche (reparentages, etc.) — `consolidate` ne traite QUE l'acceptance, pas la
     perte d'arêtes. Personne ne lance audit/restructure automatiquement.
  2. **Pas de hook de cycle de vie** : `consolidate` doit être lancé À LA MAIN avec les bons items + le bon
     merge commit ; aucune skill ne le drive au merge/branch-close, ni ne juge l'ancestry git.

## Proposition (à pressure-tester)

### B1 — Skill `branch-lifecycle` (track-aware, ships via install-skills)
Une skill portable (claude/codex/gemini) qui, au moment d'un merge / branch-close :
1. **Détecte le type de merge** (git ancestry) : fast-forward / merge-commit / squash / rebase.
2. **Détecte la dérive** : `track audit --format json` (orphelins = arêtes perdues) + items done dont
   l'acceptance est stale vs le merge commit.
3. **Répare la structure si besoin** : si des orphelins/arêtes manquent (cas squash), guide la
   reconstruction via un plan `restructure apply` (0.21.0) — plan ratifié, append-only, gate.
4. **Rafraîchit l'acceptance** : `track consolidate --items <doneItems> --commit <mergeCommit>`.
5. **Garde-fou squash** : AVERTIT explicitement quand un squash-merge va/vient de jeter des events `.track`
   commités, et recommande merge-commit pour les branches porteuses de `.track`.

### B2 — `track audit` enrichi pour le drift de merge (optionnel, si besoin code)
- Le finding `orphan` (0.21.0) couvre déjà les arêtes perdues. Évaluer l'ajout d'un finding
  `acceptance-stale-vs-commit` ou d'un mode `audit --baseline-commit <merge>` pour lister ce que
  `consolidate` devrait ré-ancrer. À TRANCHER : suffit-il de l'audit actuel + consolidate, ou faut-il un
  détecteur dédié ?

### B3 — Documentation du vecteur squash (pointeur)
- `track-operation` skill + README : « les branches qui modifient `.track` se mergent en MERGE-COMMIT
  (pas squash) ; sinon re-`restructure apply` + `consolidate` post-merge ». Le hook git-dogfood-guard (WP7)
  couvre le NON-commité ; B couvre le commité-perdu-au-squash (vecteur distinct).

## Contrat & versions
- Majoritairement SKILL (aucun changement de contrat si B2 reste hors-code). Si B2 ajoute un mode audit :
  READ minor additif. `consolidate` inchangé (déjà présent).
- Pas de nouvel event. INGEST inchangé.

## Questions consensus
Q1. La skill doit-elle AGIR (lancer restructure/consolidate) ou seulement DÉTECTER+GUIDER (record-only,
   l'humain/agent exécute) ? Cohérence avec « track records, not verifies » et la limite record-only.
Q2. Le jugement d'ancestry git (squash vs merge-commit) : dans la skill (shell git) ou faut-il un primitive
   track ? track ne doit pas exécuter git arbitraire (read-only contract). La skill, oui.
Q3. B2 : l'audit actuel (orphans) + consolidate suffisent-ils, ou un détecteur `audit --baseline-commit`
   est-il nécessaire pour lister les ré-ancrages ? (éviter le scope creep si l'existant couvre.)
Q4. Reconstruction post-squash : peut-on RECONSTRUIRE un plan restructure depuis l'état perdu, ou faut-il
   que la skill tourne AVANT le squash (capture le plan) ? Quelle est la garantie réelle ?
Q5. Garde-fou squash : simple avertissement, ou un check pre-merge (CI/hook) qui DÉTECTE qu'un squash
   jetterait des events `.track` (diff branche vs résultat squash) ?
Q6. Périmètre : B1 (skill) seul couvre-t-il le besoin (3-5), ou B2 (code) est-il indispensable ? Ordre.
