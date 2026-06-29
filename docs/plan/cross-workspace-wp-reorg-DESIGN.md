# DESIGN v2 — Réorganisation WP cross-workspace (intra-repo) + `track audit`

**Status:** design v2 — corrections du double consensus APPLIQUÉES (Opus 4.8max + Codex 5.5xhigh, tous deux
AMEND, convergents). Option verrouillée owner: **(b)+wpRootId**. Demandeurs: radar-immobilier (C) +
sent-tech-design-system. INTRA-REPO (un `.track/`); pas de cross-repo (SPEC §9). v1→v2 ferme une faille de
sécurité (capability auto-signée), un fail-open latent (clip canevas), et une justification fold fausse.

## Décision (rappel)
`workspace` = champ IMMUABLE par item (≈ sous-projet/tag). L'arbre de workpackages (`role:'workpackage'`,
`parentId`) se DÉCOUPLE du `workspace` et peut le traverser. PAS de convergence du workspace (option a
rejetée). PAS de guard relâché nu (fail-open).

## MODÈLE DE MENACE (énoncé — Opus)
Cette carve-out défend les canaux **ordinaires/automatisés** et le franchissement **accidentel** de
workspace. Elle NE défend PAS contre un process local malveillant (qui peut déjà forger n'importe quelle
écriture binding `local-user` — inchangé vs aujourd'hui). La porte sépare « reparent ordinaire » (jamais
cross-workspace) de « restructuration explicitement autorisée » (tracée, ratifiée).

## Fait de grounding (sécurité)
La containment est à DEUX couches et vérifie les DEUX côtés: le seam d'ingest vérifie le workspace de
l'ITEM (`resolveWorkspace`, ingest.ts:111) ET du PARENT (`affectedTargetWorkspaces`→`wsOf(parentId)`,
ingest.ts:195-200, rejet :229-232); le guard domaine est `track.ts:267`. **Toute commande CLI tourne
`auth:'local-user'` (CLI_PROV cli/index.ts:213) et `ctx.allowedKinds` n'est JAMAIS posé en prod (défaut =
tout permis).** Donc binding-auth ne discrimine RIEN, et un flag de payload ne confère AUCUNE autorité.

## Résolutions corrigées (v2)

### R1 — `wpRootId` DÉRIVÉ (vert au consensus, 1 précision)
wpRoot d'un item = l'ancêtre le plus haut avec **`role === 'workpackage'` STRICT** (PAS `isRoleContainer`,
qui inclut `spec-phase` — un spec-phase n'est jamais un wpRoot), en remontant `parentId`. Walk mémoïsable
O(N), terminaison garantie par le cycle-guard d'append (track.ts:277-283). Sub-WP imbriqués ⇒ le plus haut
gagne. Aucun champ stocké.

### R2 — CAPABILITY RÉELLE (C1, correction load-bearing #1)
**Le payload ne confère JAMAIS l'autorité.** Mécanisme:
- Nouveau **kind d'ingest DISTINCT, DÉFAUT-REFUSÉ**: `item.restructure`, mappé au MÊME event persistant
  `item.reparented` (payload additif `planHash`/`restructureRef`).
- **Branche deny-explicite dans `authorize`**: `if RESTRUCTURE_KINDS.has(kind) && ctx.allowedKinds?.has(kind) !== true → throw` — fail-closed PARCE QUE `allowedKinds` défaut-permet et n'est jamais posé en prod
  (on ne s'appuie PAS sur l'allowlist; on ajoute un refus explicite). `settles:'always'` (binding) en gate
  secondaire.
- Seul le flux `propose-workpackages` apply ouvre un canal qui **grant explicitement** `item.restructure`
  (capability au niveau du CONTEXTE, qu'un canal ordinaire n'a pas).
- **Facade (C4):** garder `reparentItem` inchangé (guard:267 INCONDITIONNEL, intra-only). Ajouter une
  méthode SÉPARÉE `restructureReparent` qui ne saute QUE le 267 mais exécute TOUJOURS exists/self
  (262-266), role-nesting (276) et le cycle-walk (277-283) à l'append. NE PAS conditionnaliser le 267 dans
  la méthode partagée (édit le plus risqué — ferait du chemin ordinaire une frontière de confiance).
- Le CLI direct `item reparent` (cli/index.ts) reste intra-only; un `item restructure --plan <hash>`
  distinct route vers `restructureReparent`.

### R2b — PORTÉE D'AUTORISATION par le plan (C5, blast radius)
Sauter les deux containments ferait un **god-channel** (déplacer n'importe quel item sous n'importe quel
parent). Borne: le `planHash` devient une **PORTÉE D'AUTORISATION** (pas qu'un tag d'idempotence) — le seam
vérifie **chaque arête `{itemId→parentId}` contre le plan ratifié** nommé par `planHash`. À défaut (v1
minimal), épingler **un côté** à `ctx.workspace` (un canal-W ne peut que tirer-dans/pousser-hors de W,
jamais réarranger X↔Y étrangers).

### R3a — CLIP DÉFENSIF canevas (C3, prérequis SÉCURITÉ, PAS Lot 4)
Aujourd'hui `canevas(W)` fait un **node-filter** (`node.workspace===W`, read/contract.ts:692-694) sur un
arbre tallié GLOBALEMENT ⇒ dès qu'un sous-arbre traverse: (a) il expose les leaves-V étrangères + un total
cross-workspace sous un nœud-W gardé (FUITE + % trompeur), et (b) il PERD silencieusement les leaves-W sous
une racine-V (orphelin fantôme). Corriger en **vrai leaf-clip**: ne compter/montrer que les leaves
`item.workspace===W`, rétention de nœud « garder ssi ≥1 leaf-W dans le sous-arbre », label/rollup marqué
**`partial` (« part W »)**, recalculé APRÈS pruning, jamais présenté comme total. **Non-cassant**: pour un
arbre mono-workspace, leaf-clip ≡ node-filter ⇒ rapports existants byte-identiques. À LIVRER AVANT que tout
chemin restructure ne touche des données réelles.

### R3b — vue WP-racine cross-cutting (nice, Lot 4)
`statusByWpRoot(rootId)` / rollup `wpRoot` additif dans le report = le total % d'un wpRoot à travers les
workspaces. Lecture SÉPARÉE, additive. Les reads workspace-scopés (R3a) restent item-centric.

### R4 — `track audit` = `AuditFinding[]` structuré (C6/C7)
Producteur SÉPARÉ (PAS d'inline dans `buildDirectives`, qui émet 1 directive WORK par nœud WP). Réutilise
l'**enveloppe** `Directive` + le déterminisme + l'allowlist `assertSafeCommandHint` UNIQUEMENT pour les
findings ACTIONNABLES; les findings structurels sortent en `AuditFinding`. Findings DÉTERMINISTES seulement:
- `orphan` — item ouvert sans ancêtre `role:'workpackage'` (actionnable → flux plan).
- `empty-wp` — workpackage sans leaf.
- `duplicate` — `(title, kind, workspace)` exact.
- `cross-workspace-subtree` — INFORMATIF (attendu post-reorg), chiffré, NON dispatchable.
- `singleton-workspace` — INFO (un nouveau workspace démarre légitimement à 1 item; jamais erreur).
**COUPÉ (C7):** l'heuristique de variantes de nommage (`design-system` vs `design-tokens`) = bruit
non-déterministe, locale-sensible, hors-caractère track. Si typo voulue plus tard: opt-in explicite,
advisory, jamais bloquant. `assertSafeCommandHint` interdit déjà de hinter `reparent` ⇒ l'audit ne peut pas
hinter son propre fix; le hand-off passe par le flux plan (Lot 3), pas un `commandHint`.

### R5 — Migration plan→diff→apply, préconditionnée + vérif d'INTENTION (C9)
1. `track audit` (avant).
2. Plan `{item→parent}` complet; **`planHash` content-adresse la carte COMPLÈTE** (re-plan ⇒ hash différent
   ⇒ token différent ⇒ pas faussement skippé). `clientToken = f(planHash, itemId)`, namespacé sous le plan.
3. DIFF revu (humain ratifie) AVANT tout append.
4. Apply: `restructureReparent` append-only, préconditionné par **baseline/head + diff canonique** (pas
   juste append-idempotent). Dedup store Case B (events/store.ts:236-284) ⇒ rejeu = no-op.
5. Vérif post-apply = GATE, au-delà des invariants quasi-tautologiques (workspace immuable, reparent ne
   touche que `parentId` ⇒ les comptes par workspace ne PEUVENT pas changer — ça ne prouve rien):
   (a) **intention par arête**: `parentId` foldé === `plan.target` pour CHAQUE arête;
   (b) **clôture**: l'ensemble des `item.reparented` de cet apply === EXACTEMENT les arêtes du plan (par
       clientToken), aucun reparent hors-plan;
   (c) **gate orphelins**: `track audit` après ⇒ zéro orphelin hors-plan (GATE, pas info).
   `done` reste `done`; acceptance/evidence/IDs intacts.

### R6 — Justification fold CORRIGÉE (C2 — la v1 était fausse)
`item.reparented` est réutilisé; son case fold (fold.ts:144-153) **APPLIQUE** le nouveau `parentId` — il n'y
a PAS de chemin `default:break`. Donc un lecteur ancien voit le NOUVEL arbre (correct, l'arbre EST
réorganisé), simplement SANS la provenance restructure. **La sûreté de lecture vient de R3a (clip
item-centric), PAS de l'ignorance du fold.** On N'introduit PAS d'event `item.restructured` distinct pour
« obtenir » le `default:break` (ça donnerait aux lecteurs anciens un arbre périmé/mal-buckété + doublerait
la surface fold).

### R7 — Marqueur type stream/epic EXPLICITE (C8 / Q5)
**`role:'stream'`** explicite (additif `ITEM_ROLES` ⇒ INGEST minor), PAS un niveau dérivé par profondeur
(instable sous reparent cross-workspace) et PAS un `kind`. Sépare le stream logique (wpRoot cross-cutting)
de la workpackage-feuille pour la numérotation/rollup. Timing: créer les racines cross-cutting AVEC le
marqueur dès Lot 3 (sinon numérotation transitoire WP1..WPn — churn d'AFFICHAGE seul, zéro churn de
données), à décider.

## Contraintes DS (captées)
- Single PARENT (arbre = 1 stream). Refs secondaires (stream-tags) pour items transverses = concept ADDITIF
  séparé (1 parent + N labels), Lot 5, ne casse ni single-parent ni rollup %.
- Stream = wpRoot LOGIQUE cross-workspace (pas un workspace dédié).

## Lots (REBASÉS — C3/C4)
- **Lot 0 (prérequis SÉCURITÉ):** R3a — leaf-clip défensif canevas/wpTree. Non-cassant (mono-ws byte-id).
  À livrer AVANT toute activation cross-workspace.
- **Lot 1 (débloque):** R2 capability réelle (kind `item.restructure` défaut-refusé + deny dans `authorize`)
  + `restructureReparent` séparé (C4) + R2b portée plan + `wpRootId` dérivé (R1) + message d'erreur routant.
  Bump INGEST minor.
- **Lot 2 (sûreté, // Lot 1):** `track audit` `AuditFinding[]` (R4). Bump READ minor.
- **Lot 3 (confiance):** flux restructuration tracé = étendre `propose-workpackages` (plan→diff→apply,
  préconditionné, vérif d'intention R5) + `role:'stream'` (R7). Pointeur depuis `track-operation`.
- **Lot 4 (nice):** R3b `statusByWpRoot` cross-cutting. READ minor.
- **Lot 5 (nice):** refs secondaires (stream-tags) + skill réorg globale.
Ordre: **0 → 1 (//2) → 3 → 4/5.** Le clip (Lot 0) précède tout.

## Contrat & versions
- ADDITIF. Reparent intra-workspace inchangé. Reads workspace-scopés inchangés sémantiquement (R3a est un
  fix défensif byte-identique en mono-workspace). Event `item.reparented` réutilisé (payload additif).
- Bumps: **INGEST minor** (kind `item.restructure` + `role:'stream'`). **READ minor** (`track audit` +
  `statusByWpRoot`).

## LA correction la plus importante (consensus)
**C1** — la capability doit être un grant au niveau du CONTEXTE (kind distinct DÉFAUT-REFUSÉ, deny explicite
dans `authorize`), JAMAIS un flag de payload sur un niveau de confiance (`local-user`) universel. Tant que
cette ligne n'existe pas, planHash/clip/vérif protègent un système déjà ouvert.
