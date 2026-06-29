# DESIGN — Codes WP stables + `role:'stream'` + exclusion des WP terminaux (Lot A)

**Status:** draft pour pair-consensus Codex 5.5xhigh + Opus 4.8max. Demandé par TROIS conducteurs :
graphify (WP1-N propre, legacy hors roster), sent-tech-design-system (`role:'stream'` pour ne pas
numéroter les streams en WP1-7), radar-immobilier (demande B : immuabilité des codes WP). Tout additif.

## Problème (grounded)
- `computeWpTree` (rollup.ts:286) : `roots.sort((a,b)=>a.id.localeCompare(b.id))` puis `WP${idx+1}`. La
  numérotation `WP<N>` est DÉRIVÉE de l'ordre ULID (création) des WP top-level. **Non assignable.**
- `ItemRole = 'workpackage' | 'spec-phase'` (item.ts:25). Pas de type stream/epic ⇒ les streams (qui
  agrègent des WP) sont numérotés comme des WP.
- `code?` durable est explicitement DÉFÉRÉ (item.ts:23 « A durable public `code?` label is deferred »).
- `bucketOf` : cancelled/rejected ⇒ DROPPED (buckets.ts:26). Mais un WP top-level DROPPED consomme quand
  même un slot `WP<N>` dans la numérotation.

## Proposition (à pressure-tester)

### A1 — Code durable assignable (la clé pour immo-B + graphify)
- Champ `code?: string` sur un item à rôle container (workpackage/spec-phase/stream).
- Assigné par un NOUVEL event additif `item.code-assigned { code }` (INGEST minor) — et/ou à la création
  (`item new --code <c>`). Dernier event gagne (re-assignable, tracé) ; le report l'utilise quand présent.
- Le label du report devient `node.code ?? \`WP${idx+1}\`` (dérivé en fallback — back-compat : sans code
  assigné, comportement actuel inchangé, byte-identique).
- Unicité : `code` doit être unique parmi les roots actifs d'un même scope (sinon DomainError à l'assign).
- « Immuabilité » immo-B = le code ne CHANGE PAS tout seul (rename-stable, indépendant du titre/ordre) ;
  une ré-assignation explicite reste possible et tracée.

### A2 — `role:'stream'` (additif ITEM_ROLES, INGEST minor) pour DS
- Nouveau rôle container `stream` (epic au-dessus du workpackage). Role-nesting : un `stream` contient des
  `workpackage`/`stream` ; un `workpackage` peut nicher sous `stream` ou `workpackage`.
- Le report NE numérote PAS les streams en `WP<N>`. Un root `role:'stream'` est étiqueté par son `code`
  (A1) ou un label dédié `S<N>` ; seuls les roots `role:'workpackage'` consomment la séquence `WP<N>`.
- DS : ses 7 streams deviennent `role:'stream'` (via une ré-étiquette tracée — voir migration), les WP sous
  eux numérotés relativement.

### A3 — Exclusion des roots terminaux du roster actif (graphify)
- Un root container DROPPED (cancelled/rejected) ne consomme PAS un slot `WP<N>` actif : il est soit exclu
  du roster, soit rendu sous un label distinct (ex `WPx (dropped)`), JAMAIS dans la séquence active 1..N.
- Option report `--include-terminal` (défaut : exclus de la numérotation active, toujours visibles en
  `--flat`). À trancher : auto-exclusion vs option.

## Contrat & versions
- INGEST minor (`item.code-assigned` + `role:'stream'`). READ minor (le label dérivé `code ??` + la
  séparation stream/WP dans la vue). Additif : un lecteur ancien ignore l'event code (fail-safe) et voit le
  label dérivé actuel.
- Back-compat : sans aucun `code` assigné ni `role:'stream'`, le report est BYTE-IDENTIQUE à aujourd'hui.

## Migration (consommateurs)
- graphify : assigne `code` WP1-7 à ses 7 pérennes (ou les a déjà via reparent) ; legacy DROPPED exclus.
- DS : ré-étiquette ses 7 streams en `role:'stream'` (event de rôle ? — OR : le rôle est posé à la
  création et immuable comme aujourd'hui ⇒ il faut soit un event `item.role-changed`, soit DS recrée. À
  TRANCHER : ajoute-t-on une mutation de rôle container→container tracée, bornée stream<->workpackage ?).
- immo : assigne ses codes WP stables.

## Questions consensus
Q1. `code` : event dédié `item.code-assigned` vs champ au create-only ? unicité par scope (workspace ? wpRoot ?) ? ré-assignation permise ou one-shot ?
Q2. `role:'stream'` : faut-il une MUTATION de rôle tracée (workpackage->stream) pour DS, ou seulement à la création (DS recrée/forward) ? Si mutation : la borner (jamais vers/depuis une feuille) et garder role-nesting cohérent.
Q3. Numérotation : streams = label `code` obligatoire, ou fallback `S<N>` dérivé ? les WP sous un stream : `WP<N>` global ou relatif au stream (`S1.WP1`) ?
Q4. Exclusion terminaux : auto (DROPPED roots hors séquence) vs option `--include-terminal` ? un root DONE compte-t-il encore (un WP livré reste un WP) ?
Q5. Interaction avec wpRootId (0.21.0) et le clip canevas : un `role:'stream'` est-il un wpRoot ? `wpRootId` doit-il remonter au stream ou au workpackage ?
Q6. Découpage : A1 (code) seul suffit-il à 2/3 consommateurs (immo+graphify), A2 (stream) pour DS, A3 (terminaux) en option ? Ordre des sous-lots.
