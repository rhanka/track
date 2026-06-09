# M5 + decision-presentation design — Codex (gpt-5.5 xhigh) review

Reviews `docs/plan/M5-decision-presentation-DESIGN.md` (draft). **Verdict: ship-with-changes** — the boundary
direction is right, but not as-is. All must-fixes applied to the doc (v2).

## Must Fix
1. **Use `decision.add-artifact`, not whole-dossier `reviseDossier`.** `reviseDossier` replaces the full
   dossier (`src/track.ts:269`, `src/state/fold.ts:160`). A bridge doing read-modify-write can lose concurrent
   human dossier edits or another artifact stamp. The store lock protects `seq`/`prevHash`, not semantic stale
   writes (`src/events/store.ts:66`). Add an append-only event/WorkEvent with `clientToken`.
2. **Do not store bare `comprehensionAttested?: boolean` as the decider's fact.** Track provenance records the
   channel/bridge, not the human decider (`src/events/types.ts:64`, `v2.3b-DESIGN.md:22`). h2a attestations
   have `subject`, `dossierHash`, `at`, signatures (`comprehension-attestation.ts:9`). Store record-only
   evidence refs, e.g. `comprehensionAttestations: [{ subject, h2aEventRef, attestationHash, dossierHash }]`,
   not a bridge-authored boolean that reads like Track verified human comprehension.
3. **Resolve `engagementRef` vs `negotiationRef`.** Track decisions already carry `engagementRef` (the h2a
   ENGAGEMENT, `src/model/decision.ts:54`). The h2a dossier is keyed by `negotiationId`
   (`decision-dossier.ts:39`). Either make them the same ID and drop `negotiationRef`, or explicitly store
   both with an invariant. "Correlates to" is too vague.

## Additional Changes
- Make `DossierArtifact` a **discriminated union**. The flat optional bag allows `kind:'h2a-decision-dossier'`
  with no `dossierHash` or ref.
- **Gate `decision.add-artifact` to `local-user | signed`**; a false comprehension marker is trust-sensitive
  even if not a decision outcome.
- Keep the **pointer** default. Copy only for explicit offline/legal export, and then a content-addressed
  snapshot, not a second source of truth.
- Markers are acceptable only as h2a-derived audit summaries **with evidence refs**. Bare booleans avoided.
- **Additivity is otherwise fine:** optional `artifacts?` is hash-neutral for old events (canonicalization
  drops absent/undefined — `canonical.ts:97`); read-contract bump is correct under D7 (`PLAN-v2.md:106`).
- **Scope mostly disciplined.** Track owns type/fold/read/write-seam only. DS contract + new h2a surfaces stay
  out. §3.3's DS input-shape language should be framed as an **integration requirement**, not Track defining
  D5.

## Missing For End-To-End
Define the exact **read API** exposing decision dossiers/artifacts; the **h2a hash domain**
(`computeHash(H2ADecisionDossier)`); the **artifact source binding** for `rendered-view`; the **bridge
capability/allowed-kind** configuration.

## Disposition
All three must-fixes + the additional changes applied to the doc v2 (§3.1 discriminated union +
`ComprehensionEvidence`, §3.2 append-kind, D-E correlation invariant, §3.3 integration-requirement framing,
§8 integration points). Additivity confirmed sound.
