# DESIGN v2 — Codes WP stables + `role:'stream'` + exclusion des WP terminaux (Lot A)

**Status:** v3 — LOCKED. Double consensus Codex 5.5xhigh + Opus 4.8max (les deux AMEND, CONVERGENTS).
Demandé par graphify, sent-tech-design-system, radar-immobilier (demande B). Tout additif.
**Ordre des sous-lots : A1 → A3 → A2.**

## Principe porteur (correction #1 des DEUX reviewers)
**Découpler STABILITÉ et NUMÉROTATION.** Les `code` (A1) sont l'UNIQUE mécanisme de stabilité ; le label
dérivé `WP<n>` reste POSITIONNEL/best-effort et n'est JAMAIS re-packé. Règle déterministe : **le compteur
dérivé SAUTE tout ordinal `<n>` déjà revendiqué par un `code` de la même classe** ; les codes rendent
verbatim ; ordre stable par ULID. ⇒ roster sans code = `WP1..WPN` identique (byte-identique) ; tout-codé
(graphify) = ses codes exacts ; mixte = codes + `WP<n>` comblant les trous SANS collision. **Les codes sont
des labels d'AFFICHAGE, JAMAIS une identité/ref** : `wpRef`, objective-refs et `wpRootId` restent ULID,
immunisés contre un recode.

## Problème (grounded)
- `computeWpTree` (rollup.ts:286) : roots triés par id ULID puis `WP${idx+1}` — numérotation DÉRIVÉE, non
  assignable. `roots` = container dont le parent n'est pas container.
- `isRoleContainer` est traité comme « WP numérotable » dans rollup/status (rollup.ts:184/253,
  status-by-level.ts:41) — un alias dangereux pour A2.
- `ItemRole = workpackage|spec-phase` (item.ts:25) ; `role` posé SEULEMENT à `item.created` (fold.ts:127),
  aucune mutation ; `code?` déféré (item.ts:23).
- `wpRootId` (0.21.0) = ancêtre le plus haut `role === 'workpackage'` STRICT (rollup.ts:126) — à NE PAS
  élargir silencieusement. Le design cross-workspace dit déjà « stream = wpRoot LOGIQUE ».
- `bucketOf` cancelled/rejected ⇒ DROPPED (buckets.ts:26) ; containers exclus des buckets flat
  (build.ts:88).

## A1 — Code durable event-sourcé (sous-lot 1, KEYSTONE — débloque immo complet + cœur graphify)
- Nouvel event additif **`item.code-assigned { code }`** (INGEST minor), **LWW**, **`settles:'always'`**
  (binding, auth ∈ {local-user, signed} — re-pointer un handle public est sensible à la confiance).
  L'écriture CANONIQUE. **PAS create-only** : create-only est destructeur (corriger un typo imposerait de
  recréer l'item → perte du ULID, casse de tous les `parentId`/`wpRootId`/objective-refs). `--code` au
  create = sucre qui émet le même event. Re-assignable (pas one-shot) : c'est PRÉCISÉMENT l'immuabilité
  d'immo-B (le code ne change pas *tout seul*, mais reste corrigible avec trace). Le fold porte `code?` sur
  l'item (additif).
- **Label du report** = code verbatim si présent, sinon `WP<n>` dérivé QUI SAUTE les ordinaux déjà
  revendiqués par un code (principe porteur ci-dessus). Back-compat : sans aucun code, BYTE-IDENTIQUE.
- **Unicité = roster-GLOBAL** (tous les roots du forest), PAS par workspace : `computeWpTree` est global
  (build.ts:82) puis clippé (R3a), donc deux workspaces pourraient sinon avoir chacun « WP1 » et
  collisionner dans la vue globale. Le code ne doit pas collisionner avec (a) un autre code NI (b) un
  `WP<n>` dérivé revendiqué. Sinon DomainError.
- **Revalidation SOUS LOCK** : scan d'unicité dans la section critique d'append (store appendCommand hook,
  store.ts:147), idiome déjà présent (cycle reparent track.ts:262-280, duplicateOf) — non-pur assumé.
- READ : documenter que `WpNode.label` peut être un code stable (type string inchangé) ; exposer `code?`
  optionnel sur `WpNode`/rows (READ minor additif).
- **GATE golden** : un rapport SANS code doit être byte-identique au rendu actuel (test explicite).

## A3 — Exclusion des roots terminaux du roster actif (sous-lot 2, après A1, graphify)
- **DONE reste dans le roster** (un WP livré reste un WP). Seuls **DROPPED** (cancelled/rejected) sont
  candidats à l'exclusion.
- **Pas d'auto-exclusion par défaut** (casserait le byte-identique des vieux logs à root cancelled). Choix :
  option report `--active-roster` (exclut les roots DROPPED de la séquence `WP<N>` active) ; par défaut
  inchangé. OU tombstone stable (le slot du DROPPED est gardé, pas réattribué) si on veut éviter la
  renumérotation. À TRANCHER en consensus : option vs tombstone.
- **Renumérotation** : comme A3 filtre AVANT l'attribution `WP<N>`, il vient APRÈS A1 (codes assignés) pour
  que les numéros actifs soient STABLES via `code`, pas re-dérivés. Préciser la visibilité des terminaux
  (aujourd'hui les containers sont hors buckets flat — il faut une vue dédiée, pas `--flat`).

## A2 — `role:'stream'` (sous-lot 3, DS) — 3 catégories, pas d'alias isRoleContainer
- Nouveau rôle `stream` (INGEST minor, additif ITEM_ROLES). **Trois catégories explicites** (correction
  Codex) — cesser d'utiliser `isRoleContainer` comme alias de « WP numérotable » :
  1. `spec-phase` : container, exclu des buckets flat, NON numéroté WP.
  2. `workpackage` : numéroté `WP<N>` (ou son `code`).
  3. `stream` : container épique, **NON numéroté WP**, étiqueté par son `code` (A1) OBLIGATOIRE (pas de
     dérivation `S<N>` instable). Les WP sous un stream sont numérotés **relativement** (ex `S1 / WP1`),
     modèle de rollup à expliciter.
- `computeWpTree`/`status-by-level`/`canevas` : séparer la hiérarchie stream du roster WP (ne plus mapper
  tout container en `WP<N>`).
- Numérotation : streams = séquence dérivée propre **`S<n>`** (compteur séparé), code A1 prioritaire si
  présent. WP sous un stream = relatif via le dotté EXISTANT (`S1.1`, `S1.2`) — PAS de grammaire `S1.WP1`.
  Mécaniquement : partitionner les roots par classe — `role==='workpackage'`→`WP1..n`, `role==='stream'`→
  `S1..m` ; réutiliser la récursion `${label}.${ordinal}` telle quelle. Un WP directement sous un stream
  n'est plus un root top-level ⇒ ne consomme PAS la séquence `WP<n>` (exactement le besoin DS).
- **Mutation de rôle** (DS ne recrée pas — recréer = destructeur : ULID/enfants/historique) : nouvel event
  **`item.role-changed`** (LWW, `settles:'always'`), borné **container↔container** (`workpackage↔stream`),
  JAMAIS vers/depuis une feuille (`undefined` — ça flipperait le comptage bucket et corromprait les rollups
  historiques). À l'append : **ré-exécuter `assertRoleNesting` pour l'item-sous-son-parent ET pour CHAQUE
  enfant** (obligation NOUVELLE — create/reparent ne déplacent qu'un nœud ; un role-change re-légalise tout
  le voisinage ; promouvoir un WP→stream ayant des enfants `spec-phase` casse le nesting → rejet). Pas de
  risque de cycle (ne déplace rien).
- `assertRoleNesting` gagne une clause stream : `workpackage` niche sous `workpackage` **ou `stream`** ;
  `stream` niche sous `stream` ou root.
- `isRoleContainer` (+`stream`) a **11 sites consommateurs** (scope-validate, audit, build,
  status-by-level, rollup, read/contract) — TOUS à revisiter (sinon un stream serait compté comme FEUILLE
  dans buckets/`workspaceActivity.pending` = bug latent). Le test **`scope-decl.test.ts:67`** asserte
  `ITEM_ROLES === ['workpackage','spec-phase']` exactement → à mettre à jour (preuve qu'A2 n'est pas gratuit).
- `wpRootId` reste STRICT `workpackage` ; un stream **n'est JAMAIS un wpRoot** (`wpRootId` remonte au
  workpackage topmost SOUS le stream). Le clip 0.21.0 opère post-numérotation, un nœud stream clippe comme
  les autres (gardé ssi ≥1 feuille du workspace) — aucun changement au clip au-delà de `isRoleContainer`.

## Contrat & versions
- INGEST minor (`item.code-assigned`, `role:'stream'`, `item.role-changed`). READ minor (label = code |
  dérivé ; séparation stream/WP ; option `--active-roster`). Additif : sans code/stream, byte-identique.
- Back-compat lecteurs anciens : ignorent les nouveaux events (fail-safe).

## Découpage (ordre Codex) + ce qui débloque qui
1. **A1 (code event-sourcé + unicité effective sous lock + fold/read/report)** — débloque immo + cœur
   graphify (assigner WP1-7). **Sous-lot publiable seul.**
2. **A3 (exclusion/tombstone terminaux)** — graphify legacy. Après A1.
3. **A2 (role:'stream' + 3 catégories + mutation de rôle bornée + split rollup/canevas)** — DS.

## Questions consensus restantes (pour Opus sur v2)
Q1. Unicité globale au store vs par-render-scope : le report global impose-t-il l'unicité globale, ou
   faut-il une unicité par sous-arbre/stream ? (impact A2 numérotation relative.)
Q2. A3 : option `--active-roster` vs tombstone stable — lequel évite le mieux la renumérotation ET garde la
   back-compat ?
Q3. A2 : mutation `item.role-changed` bornée vs DS recrée — le coût/risque de la mutation (fold + guards au
   changement) vaut-il l'évitement de la recréation ?
Q4. Numérotation relative sous stream (`S1/WP1`) : modèle de rollup explicite — un WP appartient-il à UN
   stream pour sa numérotation ? cohérence avec wpRootId strict.
Q5. A1 seul livré d'abord (publiable) confirmé comme le bon premier incrément ?
