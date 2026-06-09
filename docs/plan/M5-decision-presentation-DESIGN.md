# M5 + decision-presentation — boundaries & wiring (design)

**Date:** 2026-06-08 · **Status:** design, **double-reviewed (Codex + Opus → ship-with-changes, applied)** ·
**Refers:** `PLAN-v2.md` (M5, D5), `M3-deps-raci-DESIGN.md` (the `engagementRef ↔ Item.id` correlation + the
`signed` record-only pattern), `v2.3b-DESIGN.md` (`Dossier.artifacts[]` reserved; confused-deputy boundary
§2), h2a EVO-9 `2026-05-31-evo9-attention-dossier-design.md` (DEC-123, **shipped**). Reviews archived:
`docs/reviews/M5-presentation-{codex,opus}.md`.

## 0. The question this settles

"For every decision we need a presentation tool that **balances the presenter's and the decider's interest**
so comprehension is **total**." Where does it live, and how does track relate to it?

**Answer (found in the record, not reconstructed):** it is the **h2a ATTENTION pillar** (EVO-9), decided
2026-05-30 to live in **h2a** ("c'est bien dans h2a qu'il faut poser ces sujets"), and it is **already built
+ tested** (DEC-123). Track is the **system of record** that *references* it; the design system owns the
*rendered* view (M5/D5). Nothing about the presentation logic is track's to build.

## 1. Three pillars, one boundary (no duplication)

| Pillar | Owner | State | Track's relation |
|---|---|---|---|
| **Decision presentation** — risk-ranked dossier, non-biased presenter, bilateral comprehension | **h2a** (`@sentropic/h2a`) | ✅ shipped (DEC-123) | **references** it (record-only) |
| **UAT** — acceptance | **track** | ✅ shipped | owns |
| **M5 — embeddable view** — the *render* of the dossier + `report` | **design system** (contract, D5) | ⏳ to build | consumes the contract |
| **The record** — Decision + Dossier + artifact refs | **track** | partial (this doc adds `artifacts[]`) | owns |

**Boundary restated (consistent with M3):** **track = the RECORD**, **h2a = the presentation/contract
engine**, **design system = the RENDER**. The `ViewTemplateRenderer` in `sentropic/ui` is an app-local
card/list renderer and is **explicitly not M5** — M5's contract is *defined once on the design system and
consumed by track / h2a / graphify / sentropic* (PLAN-v2 §M5).

## 2. Ground truth (the real surfaces this wires to)

**h2a (`~/src/a2a-cli`, pkg `h2a`) — built:**
- `deriveDecisionDossier(input): H2ADecisionDossier` — **pure, risk-ranked**. Ranking is **procedural**
  (structural/declared flags only: `postureConflit`, `masqueImpactCollectif` (declared), `crossScopeAval`,
  `amendsSignedArtifact`, `missingSuccessCriteria`), **never a harm score / legitimacy judgment**.
- `H2ADecisionDossier = { kind, negotiationId, scope, artifactHash?, subjects[], rankReasons, items[],
  generatedAt? }`; each item carries its `rank` + structural `reasons[]`. The dossier has a **canonical hash**
  (`computeHash(H2ADecisionDossier)`).
- `evaluatePresenterBias(presenter, ctx): { subject, biased, posture }` — the **non-biased-presenter gate**
  (pure `derivePostureConflit`, subject = presenter, at `decide`). Biased ⇒ **advisory** escalation, never a
  veto. **Pure ⇒ re-derivable at render time (not frozen into track).**
- **Comprehension:** the decider attests comprehension of the **dossier hash** via `h2a attest-comprehension`
  (DEC-118) / MCP `h2a_attest_comprehension`. The attestation body is **signed by the attester**
  (`signCanonical(body,{by:instance})`) and carries `subject`, `dossierHash`, `at`, `signatures[]`
  (`packages/h2a/src/comprehension-attestation.ts`, `handlers.ts:462-489`).
- Surface today: CLI `h2a dossier --negotiation <id> [--presenter <id>] [--advisory-gate]` + the
  `h2a_attest_comprehension` MCP tool. **There is no `h2a_dossier`/`prepare_decision` MCP tool yet.**

**track (`@sentropic/track`) — built:**
- `Dossier = { context, options[], qa[], selectedOptionId?, recommendation?, resultingSpecChange?,
  decisionEvaluation? }`; `DecisionState.dossier: Dossier`, `.accountable?` (= sponsor, D6), `.engagementRef?`
  (→ an h2a ENGAGEMENT). `reviseDossier(decisionId, dossier)` emits `dossier.revised` (whole-dossier replace).
- Reserved: **`Dossier.artifacts[]` (D5/M5)** — "a future additive `Dossier` extension referencing
  decision-aid evidence; shape non-normative until M5."

## 3. The wiring (the only net-new in-track contract)

### 3.1 `Dossier.artifacts[]` — record-only reference, a discriminated union (additive)

A **discriminated union** (a flat optional bag would let `kind:'h2a-decision-dossier'` exist with no hash —
both reviewers). `canonicalize()` drops undefined ⇒ existing dossiers hash byte-identically (frozen contract
intact).

```ts
export type DossierArtifact =
  | { kind: 'h2a-decision-dossier'
      negotiationRef: string                  // the h2a NEGOTIATION id — the dossier locator. NOT the
                                              // ENGAGEMENT: Decision.engagementRef is a DIFFERENT, 1:many
                                              // link (invariant D-E: this negotiation contains that engagement)
      dossierHash: string                     // canonical computeHash(H2ADecisionDossier) presented
      comprehension?: ComprehensionEvidence[] // record-only evidence of attestations (named principals)
      label?: string }
  | { kind: 'rendered-view'                   // an M5/D5-rendered embeddable view
      viewRef: string                         // stable id/URI of the DS-rendered view
      sourceDossierHash?: string; label?: string }
  | { kind: 'mockup'; viewRef: string; label?: string }

// record-only evidence of ONE h2a comprehension attestation. Track RECORDS it; track NEVER verifies it (the
// exact M3 `signed` posture). It NAMES the attester so the record is honest about WHO comprehended — distinct
// from the bridge/channel `prov.principal` that merely RELAYED the write.
export interface ComprehensionEvidence {
  subject: string             // the principal who attested = the DECIDER (h2a actor.instance / NHI id)
  dossierHash: string         // the hash that was attested — bound INTO the fact (no-hash attests nothing)
  h2aEventRef?: string        // locator of the h2a journal attestation entry
  attestationHash?: string    // the attestation body's own hash
  sig?: ProvenanceSignature   // the recorded h2a signature (audit; never verified by track)
  at?: string                 // attested-at (h2a-supplied)
}
// Dossier += artifacts?: DossierArtifact[]
```

**Semantics (record-only, the load-bearing rule — hardened by both reviews):** track stores *that* a dossier
hash `H` was presented and *that* a **named decider** attested comprehension of `H`, as **evidence refs that
carry their own principal + signature**, never as a bridge-authored boolean. Track **never** verifies an
attestation or recomputes a rank. The attester (`ComprehensionEvidence.subject`, payload) is **distinct** from
the relayer (the channel `prov.principal` = the bridge) — conflating them is the confused-deputy the M3/v2.3b
boundary forbids. **Presenter-bias is NOT stored**: it is a pure, re-derivable gate result
(`evaluatePresenterBias`) — the DS recomputes it at render time (read-time join). Nothing frozen.

### 3.2 Who writes it — an append-only `decision.add-artifact` kind (both reviewers, must-fix)

NOT `reviseDossier` (a whole-`Dossier` read-modify-write → a **lost-update** hazard: a bridge appending an
artifact races a human editing `context`/`options`, or a second artifact stamp, and silently drops one — the
store lock guards `seq`/`prevHash`, not semantic staleness). Instead a **new additive WorkEvent + event kind
`decision.add-artifact`** that **appends one `DossierArtifact` atomically** (no dossier rewrite), idempotent
via `clientToken` (the shipped v2.3c path), **binding-gated** (auth ∈ {`local-user`, `signed`} — a false
comprehension marker is trust-sensitive). Matches the M3 precedent (`blocker.resolve-external` is its own
atomic kind, not an overload). The **h2a bridge** writes it through the M3 signed ingest seam; track gains
**no hard h2a dependency** (D4: optional sidecar; track canonical for the record, h2a for the presentation).

### 3.3 M5 embeddable-view contract (cross-repo, DS-owned, D5)

The design system defines, once, an embeddable-view contract that **renders an `H2ADecisionDossier`**
(risk-ranked, bidirectional, with its `reasons[]` surfaced) **and** track's `report`, consumed by
track/h2a/sentropic. The `viewRef` in §3.1 points at an instance. **Not built here** — it is the D5 decision
(the contract isn't track's to define) and the heaviest cross-repo piece. This doc states the *input shapes*
it must accept (`H2ADecisionDossier` + `Report`) **as an integration requirement on the DS contract, not
track defining D5.**

## 4. Additivity / frozen-contract analysis

- `Dossier.artifacts?` is an **optional additive field** on an existing payload; `canonicalize` drops
  `undefined`, so every pre-existing `dossier.revised`/`decision.create` event hashes byte-identically. The
  **new `decision.add-artifact` is a new additive kind** (no change to any existing type, seq, prevHash, or
  chain) — additive-only per D7. Same pattern as `accountable`/`engagementRef` (M3 Lot A).
- Read API: `READ_CONTRACT_VERSION` bumps (additive surface on dossiers); ignore-unknown keeps old logs valid
  (D7).

## 5. Decisions — resolved by the double-review

- **D-A — pointer vs copy → POINTER (confirmed, both).** A copy only for an explicit offline/legal export, and
  then a content-addressed snapshot, never a second source of truth.
- **D-B — write path → a new `decision.add-artifact` append kind (CHANGED from the draft, both, must-fix).**
  §3.2. Append-only + `clientToken` + binding-gated; no whole-dossier rewrite.
- **D-C — comprehension/bias → named evidence refs, not booleans (CHANGED, both, must-fix).** §3.1.
  `ComprehensionEvidence[]` names the decider + carries the h2a sig/ref; presenter-bias is **not stored**
  (read-time DS re-derivation).
- **D-D — M5 contract ownership → DS-owned (D5), confirmed.** Track only states the input shapes as an
  integration requirement; it does not define D5.
- **D-E — correlation keys (new; both flagged the draft gloss).** `Decision.engagementRef` (→ an h2a
  ENGAGEMENT) and the artifact's `negotiationRef` (→ the h2a NEGOTIATION that produced the dossier) are
  **distinct** (a negotiation contains ≥1 engagement). The binding join for comprehension is **`dossierHash`**
  (what was attested). Invariant: `negotiationRef` is the negotiation containing `Decision.engagementRef`.

## 6. Scope

- **In-track (this doc, small + additive):** the `DossierArtifact` union + `Dossier.artifacts[]` (type +
  fold + read surface); the **`decision.add-artifact`** WorkEvent/event kind (append-only, `clientToken`,
  binding-gated) on the M3 signed seam; tests (§7). **TDD, double-reviewed, no co-author, OIDC release.**
- **Cross-repo (NOT started here — owner steer):** the **M5/D5 embeddable-view contract** (DS + sentropic);
  any new **h2a** surface (e.g. an `h2a_dossier`/`prepare_decision` MCP tool for the bridge — h2a's call, not
  track's).

## 7. Test plan (in-track part)

1. **Additivity:** a `dossier.revised`/`decision.create` without `artifacts` hashes **byte-identically** to a
   pre-0.9 log (frozen-contract regression).
2. **Confused-deputy (must-test, both reviewers):** a signed-bridge `decision.add-artifact` carrying
   `ComprehensionEvidence{subject:'human:decider', sig}` records the artifact with the **attester `subject`
   distinct from the event `prov.principal` (the bridge)** — never conflated; track does **no** verification
   (`validate().ok`).
3. **Discriminated-union completeness:** a `kind:'h2a-decision-dossier'` with no `dossierHash` (or a
   `rendered-view` with no `viewRef`) is **rejected** by the mapper/validator (fail-closed).
4. **Idempotency:** a re-sent `decision.add-artifact` with the same `clientToken` appends **once**.
5. **Binding gate:** an `unauthenticated` channel **cannot** `decision.add-artifact` (auth ∈ {local-user,
   signed}).
6. **Containment:** the bridge pinned to W cannot add an artifact to a decision in V (reuse the M3 workspace
   gate).
7. **Parity / read:** CLI≡ingest parity for `decision.add-artifact`; `READ_CONTRACT_VERSION` bumped; old logs
   read unchanged (ignore-unknown).

## 8. Open integration points (specify before/with the cross-repo build)

- The **read API** exposing decision dossiers + their `artifacts[]` (the surface the DS render consumes).
- The **h2a hash domain** the `dossierHash` must equal — `computeHash(H2ADecisionDossier)` pinned so track's
  recorded hash and h2a's are the same bytes.
- The **`rendered-view` source binding** — what produces/owns a `viewRef` (the DS/M5 contract).
- The **bridge configuration** — its capability/`allowedKinds` (must include `decision.add-artifact`) and its
  signed principal.
