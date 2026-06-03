# Critique adverse Opus 4.8 — INTENTION @sentropic/track (2026-06-02)

## 1. Hypothèses fragiles ou fausses
- **H1** « le modèle intention→spec→workpackage n'existe qu'en markdown+convention » : FAUX. h2a a déjà industrialisé `INTENTION → SPECIFICATION (REQ-NNN) → CONTRACT/POLICY/ENGAGEMENT → ACTIONS+JOURNALS+EVIDENCE` (a2a-cli/VOCABULARY.md §7, README.md:64-80). ENGAGEMENT = "executable operational contract: scope, charter, success criteria, actions, journals and amendments" (SPEC REQ-048). L'intention présente comme vide ce qui est occupé par @sentropic/h2a@0.1.24.
- **H2** « intérêt → intention » comme concept neuf : FAUX. h2a EVO-9 trust model = INTÉRÊT, ATTENTION, CONFIANCE, VALEUR, plusieurs MERGÉS (PLAN.md:36-39, INTÉRÊT 0.23.0, ATTENTION 0.24.0). Collision de vocabulaire frontale.
- **H3** « keystone garde son modèle nu, aucune double modélisation » : non vérifiable, aucun code coordinate.
- **H4** saut logique « markdown non requêtable → nouveau système de record » non démontré ; un linter de frontmatter couvrirait requêtable+validable.

## 2. Frontières
- track vs BR-25 : pas de double emploi (skills = workflow mécanique sur BRANCH.md), mais lot-gate dérive DÉJÀ pass/fail de make test → le différenciateur existe en version dégradée.
- track ↔ h2a : RECOUVREMENT SÉVÈRE sous-estimé. ENGAGEMENT = objet de travail + success criteria + journal hash-chaîné signé + négociation + blockages + chaîne INTENTION→SPEC. La distinction "local vs distribué" est de transport, pas de modèle. Scénario probable : track = sous-ensemble re-modélisé de h2a.
- Packaging (lib+CLI+MCP+skills 3 hosts) = clone du packaging h2a (install-skills --host claude|codex|gemini).

## 3. Modèle de données
- Échelle de maturité unique = mélange 2 axes orthogonaux (définition vs exécution/livraison). accepted dépend des tests (révocable) → non-monotone, incompatible avec "gravit".
- Régression test rouge après accepted : redescente non spécifiée.
- bug saute interet → machine à états dépend de kind → plusieurs machines, "l'échelle EST la machine" est faux.
- TestRef.locator fragile (renommage/paramétré/supprimé) ; unknown dominant → jamais accepted auto. Pont CI→sidecar non spécifié.
- 4 conteneurs de travail concurrents : WorkPackage / Task(coordinate) / ENGAGEMENT(h2a) / Item.
- BON : séparer prose/critères structurés ; projection agile lean en mapping externe.

## 4. Plugin-par-host + cohérence LLM
- Packaging host déjà résolu par h2a → consommer, pas refaire.
- Cohérence pilotée par LLM = point le plus risqué. Résolveur LLM sur un système de record = incohérences silencieuses. Contredit h2a (REQ-054 : "no automatic resolver"). llm-mesh tiré sans budget/mode dégradé. Manque : règles déterministes d'abord, LLM en proposition non-bloquante ; "qui détient l'état réconcilié" (QO#7) = décision fondatrice.

## 5. Persistance hybride
- Désync prose/sidecar ; merge git concurrent sur YAML mutable. h2a a résolu via append-only journal + lease lock. Reco : sidecar = jsonl append-only, PAS frontmatter mutable.
- Projection modèle riche → backend pauvre (Jira sans maturité interet) : perte non définie.

## 6. Scope/YAGNI + séquencement
- Trop pour un MVP (4 surfaces "IMPÉRATIF" sans repo ni code). Sortir cohérence-LLM/consolidation multi-repo en v2+.
- Bloquants manquants : forme du sidecar (QO#1, non reportable), pont CI→TestRef, position vs ENGAGEMENT/EVO-9.
- CLI-first OK. Dépendance stp molle : BR-42a évolution-loop déférée.

## 7. Différenciateur acceptation dérivée
- Pas nouvelle (lot-gate le fait déjà). Pas solide : unknown dominant, non-monotonie, flaky (problème 1er ordre côté sentropic). Reformuler : "vue dérivée + override tracé + politique flaky".

## 8. Verdict + 3 changements imposés
NE PAS écrire la spec en l'état. Prémisse de vide factuellement occupé par h2a.
1. Trancher le recouvrement track↔h2a par tableau concept-à-concept ; résoudre collision intérêt/intention.
2. Refonder la machine à états sur 2 axes orthogonaux ; acceptation révocable + unknown/flaky/override.
3. Geler la persistance (append-only jsonl aligné h2a) + contrat round-trip + pont CI→TestRef.
À conserver : CLI-first ; agile lean hors-cœur ; UAT v1.1 ; non-goals.
