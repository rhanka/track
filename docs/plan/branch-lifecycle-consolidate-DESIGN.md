# DESIGN v2 — Skill branch-lifecycle track-aware + check pre-merge anti-perte (Lot B)

**Status:** v2 — AMEND Codex 5.5xhigh appliqué. Opus à venir sur v2. Motivé par l'incident graphify : un
squash-merge GitHub d'une branche `.track` a JETÉ 18 reparentages POURTANT commités ; `audit` a révélé les
orphelins ; `restructure apply` a réparé (parce que graphify avait encore le ref de branche).

## Recadrage porteur (correction #1 Codex)
**La récupération post-squash est IMPOSSIBLE** sans ref de branche ni artefact pré-capturé : `restructure
apply` APPLIQUE/vérifie un plan, il ne l'INVENTE pas ; on ne peut pas déduire des parents perdus depuis
l'état `.track` restant. ⇒ **la garantie se déplace AVANT le squash : prévention, pas réparation.** Le hook
git-dogfood-guard (WP7) protège le `.track` NON-commité ; Lot B couvre le commité-perdu-au-squash (vecteur
distinct).

## B0 — Check PRE-MERGE anti-perte d'events (la vraie garantie)
- Un check (CI / pre-merge hook) qui **DÉTECTE qu'un squash jetterait des events `.track`** et **BLOQUE/échoue**
  la PR (avertir ne suffit pas — Codex Q5). Mécanique : comparer les events `.track` de la branche vs ce que
  le squash produirait ; si la branche a appendé des events absents du résultat squash ⇒ fail.
- Recommandation de politique : **les branches qui modifient `.track` se mergent en MERGE-COMMIT** (pas
  squash). Le check encode cette règle de façon exécutable.
- Forme : un sous-commande/verbe ou un script CI invocable. À TRANCHER : verbe `track` (lecture git en
  frontière, comme le CLI normalise déjà des commits) vs script de skill pur. Le CORE/READ reste record-only
  et ne lance pas de git arbitraire ; la lecture d'ancestry vit dans la skill/CI (Codex Q2).

## B1 — Skill `branch-lifecycle` (track-aware, ships via install-skills) — DÉTECTE + GUIDE (record-only)
La skill ne RÉPARE pas en autonomie (Codex Q1). Au merge/branch-close :
1. **Juge l'ancestry git** (shell, dans la skill) : fast-forward / merge-commit / squash / rebase.
2. **Détecte la dérive** : `track audit --format json` — NB `orphan` est un **symptôme PARTIEL** (l'audit ne
   voit que les feuilles ouvertes sans ancêtre WP), pas un détecteur complet de merge-loss. + acceptance
   stale vs le merge commit (via `query`/`report` baseline-aware).
3. **Guide la réparation de structure** : si dérive, propose un plan `restructure apply` — UNIQUEMENT sur un
   plan ratifié explicite (jamais autonome), et SEULEMENT si le ref de branche/diff est encore disponible
   (sinon : irrécupérable — le dire franchement).
4. **Guide le rafraîchissement d'acceptance** : `track consolidate --items <doneItems> --commit <merge>`.
   Algorithme de sélection (Codex correction 3) : items `done` dont l'acceptance est STALE vs le merge
   commit ET encore accepted-at-own-commit ; VÉRIFIER après lecture (le `ok` de consolidate peut couvrir des
   skips — le predicate d'éligibilité track.ts:136 SKIP certains items).
5. **La skill ORCHESTRE le CLI existant** (`audit`, `restructure apply`, `consolidate`) — elle ne les
   RÉIMPLÉMENTE pas (Codex correction 4).
- Packaging (Codex correction 5) : `skills/branch-lifecycle/SKILL.md` ; `install-skills` découvre déjà les
  skills, `package.json` embarque `skills`.

## B2 — Détecteur dédié (OPTIONNEL, hors premier incrément)
- `audit --baseline-commit <commit>` listant les ré-ancrages que `consolidate` ferait — **PAS maintenant**
  (Codex Q3/Q6 : `query`/`report` baseline-aware + `consolidate` suffisent ; ne pas étendre `audit`
  prématurément ni dupliquer `consolidate`). Si un jour code : détecteur pre-merge/event-loss dédié, distinct.

## Contrat & versions
- B0 + B1 = SKILL + (éventuel) verbe de check git-frontière. Si B0 reste un script de skill : AUCUN
  changement de contrat. Si B0 devient un verbe `track` : à spécifier (lecture seule, frontière git). `consolidate`/`restructure apply`/`audit` inchangés. INGEST inchangé.

## Découpage + ce qui couvre le besoin
1. **B0 (check pre-merge anti-perte)** — la VRAIE garantie (prévention). Premier incrément.
2. **B1 (skill branch-lifecycle detect+guide)** — orchestration au merge/branch-close. Avec B0.
3. **B2 (détecteur dédié)** — différé, seulement si l'existant ne couvre pas.

## Questions consensus restantes (pour Opus sur v2)
Q1. B0 : verbe `track` (lecture git en frontière) vs script CI pur ? lequel garde le mieux le contrat
   record-only/read-only tout en étant exécutable en CI ?
Q2. Le check « un squash jetterait des events » : faisable de façon fiable en CI (diff branche vs base) ou
   y a-t-il des cas où c'est indécidable avant le merge ?
Q3. Politique merge-commit-obligatoire : l'encoder dans le check (fail) ou la documenter + warning ? (Codex
   tranche : fail.)
Q4. La skill doit-elle pouvoir capturer un plan restructure AVANT le squash (pour rendre la réparation
   possible) — ou est-ce hors-scope (B0 prévient, donc inutile) ?
Q5. B1 seul (skill) suffit-il sans B0, vu que sans prévention la perte est irrécupérable ?
