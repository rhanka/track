# DESIGN — Préconisation actionnable & délégable du report conductor

**Status:** design LOCKED — double consensus Codex 5.5xhigh + Opus 4.8max (les deux AMEND, convergés ;
3 désaccords résolus ci-dessous). Owner steer: priorité = mix (c). Lot additif, READ minor bump.

## Problème
La colonne `préconisation` (section DÉCISIONS/ACTIONS) est un TEXTE CONSTANT: `buildWpConductorView()`
prend `leaves[0]` (1er open leaf, arbitraire par `id`) et émet la même phrase pour chaque WP. Aucun
raisonnement, non délégable. L'owner veut chaque préconisation (1) actionnable, (2) dérivée de l'état réel,
(3) délégable telle quelle à un subagent.

## 1. Enrichir `WpLeaf` (additif, pur — src/report/rollup.ts)
Tout est déjà dérivable dans `computeWpTree(state, config)` via `acceptanceStatus` + `effectiveOpenBlockersForItem`.
Ajouter à `WpLeaf`: `workspace`, `realization`, `acceptance`, `priority?: number` (WSJF score), `specStatus`,
`accountable?`, et — correction décisive de Codex — `openBlockers[]` `{ blockerId, kind, ref?, scope?,
resolutionRule?, engagementRef?, reason }`. Le booléen `awaitedOnDecision` ne suffit pas: sans `ref`
(= `decisionId`), la directive « trancher la décision » n'est pas délégable.

## 2. Sélecteur = 2 axes ORTHOGONAUX (routage ⊥ urgence)
Ne PAS faire un ordre total unique (erreur de catégorie de la v1).

**A. ROUTAGE (qui agit), par leaf →** `mode`:
- blocker `kind:'decision'` ouvert ⇒ `human-decision` (ligne décision propre)
- `engagementRef` présent, leaf non-DONE ⇒ `h2a-engagement` (ligne engagement propre)
- sinon ⇒ `subagent` | `local`
Les decision/engagement-waits sortent en lignes propres (déjà le cas) — ils ne sont PAS dans le sélecteur
d'urgence.

**B. URGENCE (quelle leaf), sur le sous-ensemble délégable**, ordre final (D1 résolu = Opus):
1. gate bloquant réel (dependency/manual blocker ouvert) — `rank P1_GATE`
2. `acceptance == 'fail'` — `P2_ACCEPTANCE` (sous-rang fail)
3. `realization == 'in-progress'` + blocker `dependency` ouvert (WIP coincé)
4. `realization == 'in-progress'` (flux — finir avant de démarrer)
5. `acceptance == 'stale'` — `P2_ACCEPTANCE` (sous-rang stale, < fail)
6. `specStatus` exige spec — gate spec
7. `realization == 'to-do'` par **WSJF desc** — `P4_TODO_WSJF`
8. fallback — `P5_FALLBACK` : **JAMAIS `id` seul** tant qu'un signal d'état existe ; tie-break final
   `WSJF desc (undefined last) → wp.id → target.id`.

**Scope (correction angle mort, confirmé via `bucketOf`)**: le sélecteur opère sur
`openLeaves(wp) ∪ doneLeavesAvecAcceptance∈{fail,stale}(wp)` moins decision/engagement-waits. Un item
`done` mais `acceptance fail/stale` (invisible dans DONE en `requireAccepted=false`) est la dette
délégable la plus précieuse.

**acceptance `unknown`/`waived`/`n/a`**: ne PAS émettre « re-run acceptance » (rien à runner / waiver
intentionnel) — court-circuit.

## 3. Directive — schéma langue-neutre (additif au `view`)
```
interface Directive {
  id: string                          // stable, pour dispatchQueue
  target: { kind: 'item'|'decision'|'blocker'|'engagement'|'wp'; id: ItemId; title?: string; workspace?: string }
  scope:  { wpId?: ItemId; wpLabel?: string }
  mode:   'human-decision' | 'h2a-engagement' | 'subagent' | 'local'
  gate?:  { code: 'decision-pending'|'engagement-pending'|'external-dependency'|'linked-dependency'
                 |'manual-blocker'|'spec-not-ready'|'acceptance-failed'|'acceptance-stale'|'priority-missing'
            ref?: string }            // ref = decisionId / engagementRef / blockerId
  step:   { code: 'focus-decision'|'settle-decision'|'resume-engagement'|'resolve-external-blocker'
                 |'amend-spec'|'fix-acceptance'|'rerun-acceptance'|'finish-increment'|'start-increment'
                 |'prioritize-backlog'|'inspect-fallback' }
  rank:   'P1_GATE'|'P2_ACCEPTANCE'|'P3_IN_PROGRESS'|'P4_TODO_WSJF'|'P5_FALLBACK'
  facts:  { bucket; realization; acceptance; wsjf?: number; specStatus; accountable?; blockerRefs?: string[] }
  affordances: WorkEventKind[]        // les écritures LÉGALES, pas des écritures présumées
  commandHint?: string                // allowlist read/focus/measure UNIQUEMENT (voir §5)
}
```
Aucune phrase stockée. Les enums sont un VOCABULAIRE gouverné (additif seulement, jamais de rename ;
consumer inconnu ⇒ `inspect-fallback`).

## 4. `view` enrichi + back-compat (D2 résolu = compromis)
- `view.directives[]` : toutes les directives (machine, langue-neutre).
- `view.dispatchQueue[]` : file priorisée à plat (top-N `directiveId`) — le payload de délégation
  subagentique réelle. **JSON seulement.**
- `view.tables` + `view.generalRecommendation` : conservés, **dérivés** des directives (rendu/back-compat).
- **Pas de 4ᵉ table dans le report CLI** ce lot (les 3 tables + la directive par-WP suffisent à l'écran ;
  la queue vit dans le JSON pour les subagents + la skill).

## 5. Limite record-only (Q4 — les deux, ferme)
`commandHint` = verbes de **mesure / attention / focus** uniquement, argv allowlistés:
- OK: `track focus <decisionId>`, `track accept run <evidenceId>` (produire une vraie evidence), `track blocker raise`
- **INTERDIT**: `track item realize <id> done`, `track accept … pass|waived` (= affirmer/fabriquer un outcome
  non substantié). `resolve-external`/`blocker resolve` = conditionnel (« quand le retour est réellement intégré »).
`affordances` dit ce qui est LÉGAL ; la directive ne présume jamais d'écriture.

## 6. Priorité — mix (c) (owner steer)
WSJF quasi-absent en pratique ⇒ le tier `to-do par WSJF` dégénère. Résolution:
- **proxies de valeur par défaut** (acceptance-debt → in-progress → blockers → ancienneté), `id` en tout dernier ;
- quand le délégable d'un WP est « tout `to-do`, aucun WSJF, aucun discriminant » ⇒ directive
  `step:'prioritize-backlog'` + `gate:'priority-missing'` (mode `subagent`, `commandHint: track priority assess <id>`).
  L'absence de priorité devient une **action déléguable**, pas un fallback silencieux.

## 7. Contrat & versions
- `view` reste un champ OPTIONNEL (un consommateur ancien ne le voit pas) — non breaking.
- Le vocabulaire d'enums est gouverné comme le contrat read (additif, jamais rename, `inspect-fallback`).
- **READ_CONTRACT_VERSION minor bump** (1.13.0 → 1.14.0). Aucun event nouveau. INGEST inchangé.

## 8. Désaccords consensus — résolutions (tracées)
- **D1** in-progress vs stale: pris **Opus** (`in-progress > stale`: stale = dette douce, finir le WIP d'abord). Seul bouton réglable.
- **D2** dispatchQueue: **compromis** — dans le JSON ce lot, pas de 4ᵉ table CLI.
- **D3** enums = contrat ? **les deux à deux niveaux**: `view` optionnel (Opus) + enums gouvernés/minor-bump (Codex).

## 9. Plan de test (TDD)
P1 decision ref exacte (decisionId présent dans la directive) · blocker extra/h2a · P2 fail/stale même sur
DONE en `requireAccepted=false` · P3 in-progress vs P4 WSJF · WSJF-absent ⇒ jamais `id` seul · `prioritize-backlog`
quand 0 WSJF · tie-breaks stables (déterminisme, pas de flicker) · JSON additif (`buckets/wpTree/wpTotals`
intacts) · aucun `commandHint` write/pass · `inspect-fallback` sur code inconnu · 6 lignes identiques → 6 directives distinctes (régression du grief).

## 10. Lot
Un seul lot additif: rollup (WpLeaf+openBlockers) → sélecteur → directive/dispatchQueue → renderers (tables
dérivées + renderer FR mince) → READ 1.14.0 → tests. Build en TDD, gate Codex+Opus sur l'implémentation
AVANT tag/publish.
