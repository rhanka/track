# DESIGN — Réorganisation WP cross-workspace (intra-repo) + `track audit`

**Status:** design — décision d'OPTION verrouillée (owner rhanka): **(b)+wpRootId**. Demandeurs:
radar-immobilier (demande C) + sent-tech-design-system (co-stakeholders). Double consensus Opus 4.8max
+ Codex 5.5xhigh sur l'assessment. CE doc résout les questions de design restantes et part EN consensus
avant build. INTRA-REPO uniquement (un `.track/`). Pas de cross-repo (hors-scope, SPEC §9).

## Décision (rappel)
`workspace` = champ texte IMMUABLE par item (≈ son sous-projet/tag). L'arbre de **workpackages**
(`role:'workpackage'`, lié par `parentId`) se **DÉCOUPLE** du `workspace` et peut le traverser. On NE
fait PAS converger le `workspace` de l'item (option (a) rejetée: ça le ferait "changer de projet" = la
confusion à éviter). On NE relâche PAS le guard nu (option (b)-nu rejetée: fail-OPEN des lectures).

## Fait décisif (sécurité) à respecter
La containment cross-workspace est enforced à DEUX couches: le guard domaine (`track.ts:267`) ET le
**seam d'ingest** (`ingest.ts` ~195-233) — « load-bearing security property »: un canal épinglé au
workspace W ne peut jamais toucher V. On ne SUPPRIME pas cette propriété; on la **remplace** par une
autorisation de RESTRUCTURATION traçable pour le seul chemin reparent-cross-workspace.

## Résolutions des questions ouvertes (à pressure-tester en consensus)

### R1 — `wpRootId` est DÉRIVÉ, pas stocké
Le `wpRoot` d'un item = l'ancêtre `role:'workpackage'` le plus haut en remontant `parentId`. Calculé dans
`computeWpTree` / un helper pur. AUCUN nouveau champ stocké (évite le drift, reste additif/pur). C'est la
2ᵉ clé de lecture pour les vues WP cross-cutting.

### R2 — Le reparent garde l'event `item.reparented`; le GUARD devient CONDITIONNEL à une capability
- Reparent **intra-workspace** (`parent.workspace === item.workspace`): inchangé, aucune capability.
- Reparent **cross-workspace**: AUTORISÉ uniquement via la **capability de restructuration** —
  `prov.auth ∈ BINDING_AUTH` {local-user, signed} ET un discriminant `restructure` portant un `planHash`
  (+ `restructureRef`). Enforced AUX DEUX couches (facade `reparentItem` + seam d'ingest).
- Donc la propriété de sécurité devient: « un canal ordinaire épinglé à W ne peut toujours pas atteindre
  V ; SEULE une opération restructuration-autorisée le peut, et elle est tracée (planHash) ». La
  containment n'est pas retirée — elle est gated par la capability.
- Le message d'erreur du guard (cas non-capability) ROUTE: « reparent cross-workspace nécessite le flux de
  restructuration (`track audit` + plan ratifié) » au lieu du sec `cannot reparent across workspaces`.

### R3 — Les lectures workspace-scopées restent ITEM-CENTRIC (pas de fail-open)
- `canevas(W)` / `workspaceActivity(W)` continuent de filtrer par `item.workspace` (inchangé, contrat
  préservé). Pour un WP dont le sous-arbre traverse les workspaces, `canevas(W)` **clippe** aux leaves
  dont `item.workspace === W` (le nœud WP est montré avec SES enfants-W seulement; le rollup % de cette
  vue est explicitement « part W du WP », pas le total).
- La vue WP cross-cutting (rollup % total d'un wpRoot à travers les workspaces) est une lecture
  **SÉPARÉE additive**: `statusByWpRoot(rootId)` / l'inclusion d'un rollup `wpRoot` dans le report. Jamais
  `canevas(W)` ne change de sens en silence.

### R4 — `track audit` (read-only, additif) → findings = DIRECTIVES (compose avec le moteur 0.20.0)
Détecte la dérive de structure et émet des `Directive` actionnables (réutilise `src/report/directive.ts`):
- `orphan` — item ouvert sans ancêtre `role:'workpackage'`.
- `cross-workspace-subtree` — un wpRoot dont le sous-arbre traverse des workspaces (INFORMATIONNEL,
  attendu post-reorg; chiffré pour visibilité, pas une erreur).
- `incoherent-workspace` — une valeur de `workspace` portée par 1 seul item (probable typo) ou variantes
  proches (heuristique de nommage).
- `duplicate` — même (title, kind, workspace).
- `empty-wp` — `role:'workpackage'` sans aucune leaf.
- `unrooted-reorg-debt` — items que le plan de reorg n'a pas encore adoptés.
Sortie: JSON (machine) + table CLI. Chiffre la « dette de structure ». READ minor.

### R5 — Migration (immo 111/14, DS 25/9), append-only, sans perte d'historique
Flux `plan → diff → apply` (Lot 3, via la skill `propose-workpackages` étendue):
1. `track audit` (avant) — état de référence.
2. Générer le plan `itemId → wpRoot/parent cible` (+ création des wpRoots manquants).
3. DIFF revu (humain ratifie) — avant tout append.
4. Apply: uniquement des `item.reparented` (restructure-capability) append-only, `clientToken`
   déterministe + `planHash` (idempotent: re-apply = no-op).
5. `track audit` (après) + vérif: intégrité, zéro cycle, role-nesting, MÊMES item ids, MÊMES
   réalisations/acceptance, MÊMES comptes DONE/DROPPED/active par workspace. `done` reste `done`.
Aucun hand-edit `.track`, aucune recréation d'item.

## Contraintes DS captées (à intégrer)
- **Single PARENT** (l'arbre = 1 stream primaire) confirmé. Les **refs secondaires (stream-tags)** pour
  items transverses (MenuTriggerButton ∈ S1+S7) = concept ADDITIF SÉPARÉ (1 parent + N labels optionnels),
  PAS du multi-home, PAS un split forcé → lot ultérieur (Lot 5 nice), ne casse ni le single-parent ni le
  rollup %.
- **Stream = wpRoot LOGIQUE cross-workspace**, pas un workspace dédié.
- **Type stream/epic ≠ workpackage-feuille** pour que le report ne numérote pas les streams `WP26→WP32`:
  raffinement de modèle (probable niveau/role marker, PAS un nouveau `kind`) — à spécifier.

## Lots
- **Lot 1 (INDISPENSABLE, débloque):** capability de restructuration (reparent cross-workspace gated
  binding-auth + planHash) aux 2 couches (facade + seam) ; `wpRootId` dérivé ; message d'erreur routant ;
  bump INGEST minor. NE touche aucun read existant.
- **Lot 2 (INDISPENSABLE, sûreté, en //):** `track audit` read-only → directives ; bump READ minor.
- **Lot 3 (INDISPENSABLE, confiance):** mode restructuration tracé = étendre `propose-workpackages`
  (plan→diff→apply, idempotent, vérif post-apply) ; pointeur depuis `track-operation`.
- **Lot 4 (nice):** lecture WP-racine cross-cutting (`statusByWpRoot` / rollup wpRoot dans report) ;
  bump READ minor.
- **Lot 5 (nice):** refs secondaires (stream-tags) + distinction type stream/epic + skill réorg globale.
Ordre: 1 → 2 (//) → 3 → 4/5.

## Contrat & versions
- ADDITIF, non cassant. Reparent intra-workspace inchangé. Reads existants inchangés (item-centric).
- Event: `item.reparented` réutilisé + discriminant `restructure`/`planHash` (additif au payload).
- Bumps: **INGEST minor** (capability restructuration). **READ minor** (`track audit` + lecture wpRoot).
  Fold `default: break` ⇒ back-compat lecteurs anciens (ignorent le discriminant, voient l'item sous son
  ancien parent — fail-SAFE, jamais de fuite).

## Questions pour le consensus (pressure-test)
Q1. La capability au seam: un `restructure:true`+`planHash` sur le reparent WorkEvent suffit-il, ou faut-il
   un `kind` d'ingest distinct ? La binding-auth {local-user, signed} est-elle le bon gate ?
Q2. `canevas(W)` clip vs marquage: clipper aux leaves-W est-il la bonne sémantique (vs montrer le nœud
   cross-workspace avec un flag) ? Risque de surprise conducteur ?
Q3. `wpRootId` dérivé: coût/déterminisme sur de gros forêts ? cas d'un item sous PLUSIEURS niveaux de WP
   (sub-WP) — wpRoot = le plus haut, ok ?
Q4. `track audit` `incoherent-workspace`: heuristique de nommage (variantes proches) — fiable ou bruit ?
Q5. Le discriminant type stream/epic vs leaf workpackage: niveau (profondeur) dérivé, ou marqueur explicite
   (role:'stream') ? Impact sur le rollup/numérotation.
Q6. Migration idempotente: `planHash` + `clientToken` déterministe — collision/rejeu sûrs ?
Q7. Angle mort sécurité: une capability mal gated peut-elle laisser un canal ordinaire faire un
   cross-workspace ? (le test le plus important.)
