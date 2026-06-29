# DESIGN v3 — Anti-perte d'events au merge : `.gitattributes union` + verbe de containment + skill (Lot B)

**Status:** v3 — LOCKED. Double consensus Codex 5.5xhigh + Opus 4.8max (les deux AMEND ; un DÉSACCORD
tranché, voir ci-dessous). Motivé par l'incident graphify (squash-merge a jeté 18 reparentages commités ;
réparé via `restructure apply` PARCE QUE le ref de branche survivait).

## Désaccord tranché (gate predicate)
- **Codex** : fail si la PR `.track` n'est pas un merge-commit (squash interdit).
- **Opus** : c'est le MAUVAIS prédicat — trop faible (un merge-commit au driver par défaut sur un log
  divergent perd/conflite aussi) ET trop fort (un squash d'un `.track` NON-divergent ne perd RIEN → faux
  positif qui entraîne le contournement). Le vrai invariant = **containment d'ensemble d'events**.
- **Décision : Opus.** Le gate vérifie `events(post-merge réel) ⊇ events-net-nouveaux(branche)`, pas un
  proxy squash-vs-merge-commit. Décidable, sans faux positif (ids ULID stables + log append-only ⇒ union
  d'ensembles bien définie ; seul aléa = TOCTOU base-bouge, fermé par required-status-check up-to-date).

## Recadrage porteur
La récupération post-perte n'est PAS « impossible » dans l'absolu : elle est **opportuniste** depuis une
copie survivante (ref/reflog) — c'est exactement ce qui a sauvé graphify (events RELUS depuis le `.track`
de la branche, pas inventés). « Irrécupérable » seulement si aucune copie ne survit. ⇒ la garantie est
d'abord **préventive**, avec une récupération opportuniste en second.

## B0a — DIFFÉRÉ (gate impl, décision Codex+Opus convergente) — `.gitattributes merge=union` + `reseal`
**Statut : NON shippé dans ce lot.** Le build a prouvé (et le gate a confirmé) qu'un union-merge ATTEINT
l'anti-perte (tous les events survivent, `fold` récupère tout) MAIS casse la chaîne `prevHash` au raccord →
`validate` émet 1 finding ET le log union-mergé **n'est pas ré-appendable** (`appendCommand` fail-close
« refusing to extend an invalid log », store.ts:125) tant qu'il n'est pas RE-SCELLÉ. Aucun verbe `reseal`
n'existe. ⇒ shipper `union` seul gèlerait les writes sur sa propre voie nominale, sans sortie outillée
(hand-edit interdit). **Décision : DIFFÉRER `union`, l'apparier à un futur verbe `reseal`** (re-chaîne
prevHash/seq/contentHash, réécrit head.json, préserve les `id`, testé avant tout append) — spec'é en pair
Codex+Opus dans un lot ultérieur. La protection N'EST PAS perdue : sans union, un merge disjoint conflicte
sur `events.jsonl` ⇒ `check.sh` lit un candidat à marqueurs ⇒ `events-contains` rc=2 ⇒ FAIL fermé (bloqué,
zéro perte silencieuse). `src/events/union-merge.test.ts` est CONSERVÉ : il épingle l'invariant réel du
store (union-mergé = tous events + chaîne cassée + append gelé) et documente pourquoi `reseal` est requis.

### (déféré) `.gitattributes merge=union` (le 80%, le moins cher) — revient apparié à `reseal`
- Ajouter `.track/events.jsonl merge=union` (et le `.gitattributes` adéquat). Le store est un **NDJSON
  unique append-only** (grounded : eventsPath + head.json reconstructible) ⇒ l'union-merge réconcilie
  automatiquement des events d'aggregates DISJOINTS sur deux branches — **aurait prévenu graphify sans aucun
  gate**.
- Garantir que `validate` / la reconstruction du `head.json` TOLÈRENT un log union-mergé (ordre de tail
  potentiellement entrelacé ; head non-autoritatif/reconstructible — déjà le cas). Ajouter un test :
  deux branches qui appendent des events disjoints, union-merge ⇒ `validate` ok, tous les events présents.
- Limite : l'union ne réconcilie PAS deux writes divergents sur le MÊME aggregate/seq (conflit réel) — c'est
  le résiduel que B0b/B1 traitent.

## B0b — UNE primitive record-only : containment d'ensemble d'events (sert B0 ET B2)
- Nouveau verbe `track` **PUR, record-only, SANS git** : prend DEUX logs `.track` en entrée (ou un log + une
  liste d'ids), fold + **diff/containment d'ids** ⇒ « ids présents dans A absents de B ». Testable sans git,
  lisible par MCP, préserve l'invariant « core git-free » (tout read git reste à la frontière CLI/skill,
  jamais dans le core — confirmé : `resolveCommit`/`gitHead`).
- **Wrapper CI** (script de skill, PAS dans le core) : produit le `.track` candidat par **trial-merge git
  RÉEL** contre la base live, puis appelle le verbe ; **FAIL si `post-merge ⊉ branche-net-nouveaux`**. C'est
  le gate B0 — backstop précis pour le cas same-aggregate que l'union (B0a) ne couvre pas.
- B2 (« détecteur dédié » de la v2) FUSIONNE ici : c'est le même primitif. Plus de B2 séparé.

## B1 — Skill `branch-lifecycle` (detect + GUIDE, record-only) — orchestration
Au merge/branch-close, la skill (ne répare jamais en autonomie) :
1. **Détecte la perte structurelle via le verbe B0b** (PAS via `audit.orphan` : une perte de reparent vers
   un parent VALIDE — le cas graphify — produit ZÉRO orphelin ; l'audit est aveugle à ce mode). 
2. **Récupération opportuniste** : si dérive, tente d'abord de RELIRE/ré-ingérer les events perdus depuis le
   ref/reflog SURVIVANT de la branche ; ne déclare « irrécupérable » qu'en fallback (aucune copie).
3. **Fraîcheur d'acceptance** : `query`/`report --commit <merge> --require-accepted`, puis `consolidate
   --items <done> --commit <merge>` ; **RE-LIRE après** et surfacer les done-mais-SKIPPÉS (critère `fail`
   vivant / `waived`-only ⇒ inéligible) comme « NON consolidés — à traiter » (cmdConsolidate n'imprime que
   `ok`, jamais le compte des skips — index.ts:833).
4. **Orchestre le CLI existant** (`audit`, le verbe B0b, `restructure apply`, `consolidate`) — ne
   réimplémente rien.
- Sélection consolidate : donner TOUS les items done est sûr (`consolidate` self-filtre via
  `isConsolidationEligible`, track.ts:136) ; « stale-vs-merge » n'est qu'une optimisation no-op.
- Packaging : `skills/branch-lifecycle/SKILL.md` + `skills/branch-lifecycle/check.sh` (asset). `install-skills`
  découvre tout dossier avec SKILL.md et copie `assets/` verbatim ; `package.json files` inclut `skills`.
  (NB : le hook git-dogfood-guard WP7 N'EXISTE PAS dans le repo — aucune dépendance narrative dessus.)

## Contrat & versions
- B0a = fichier `.gitattributes` (aucun changement de contrat code ; + test validate union). B0b = verbe
  `track` PUR record-only (READ minor additif, ou un verbe util sans bump si hors surface read). B1 = skill
  (aucun contrat). `consolidate`/`restructure apply`/`audit` inchangés. INGEST inchangé.

## Périmètre minimal (anti-perte au merge) + ordre
1. **B0a `.gitattributes merge=union`** + test validate union — **le 80%, aurait suffi pour graphify.**
2. **B0b verbe containment d'events** (pur) + wrapper CI trial-merge (fail si non-containment) — backstop
   same-aggregate.
3. **B1 skill** (detect via B0b + récupération opportuniste ref/reflog + consolidate re-read) — ergonomie.
B1 sans B0 ne PROTÈGE pas (trop tard + aveugle) : B0 est la pièce porteuse, B1 le confort.

## Résolutions consensus
- Gate = containment d'events sur le merge réel (Opus), PAS proxy squash. ✓
- `.gitattributes union` = prévention par construction (Opus). ✓
- B0/B2 = une primitive (Opus). ✓
- Récupération opportuniste depuis ref survivant (Opus), pas « impossible ». ✓
- Détection via diff d'events, pas `audit.orphan` (Opus — audit aveugle au cas graphify). ✓
- Skill record-only orchestrant le CLI, packaging assets (les deux). ✓
- WP7 inexistant : dépendance retirée (Opus). ✓
