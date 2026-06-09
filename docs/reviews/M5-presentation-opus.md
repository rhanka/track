# M5 + decision-presentation design — Opus 4.8 review

Reviews `docs/plan/M5-decision-presentation-DESIGN.md` (draft). **Verdict: ship-with-changes.** Architecture
sound, boundary instinct correct (track points, h2a holds, DS renders). One must-fix + three smaller
corrections. All applied to the doc (v2). Paired with `M5-presentation-codex.md` (strongly convergent).

## 1. Boundary integrity / record-only — the most important question
Recording h2a-derived markers does **not** violate record-only per se — it is the exact M3 `signed` posture
(`types.ts:63-70`): record *that* an attestation was received, never verify it. The line: **record the fact +
its provenance; never recompute the judgment.**

**But the doc fails the confused-deputy test (the must-fix).** h2a's comprehension attestation is a **signed
body** — `signCanonical(body,{by:args.instance})` wrapped in a journal entry with `actor:{instance,role,scope}`
+ `signatures:[…]`, `subject = the decider who attested` (`handlers.ts:462-489`). The draft kept a bare
`comprehensionAttested?: boolean`; the write travels the signed channel so the event's `prov.principal` is
**the bridge's**. Net: the record says *"the bridge recorded comprehensionAttested=true"* — it **erased who
comprehended**. That is precisely the confused-deputy v2.3b §2 forbids: a relay asserting a judgment on a
principal's behalf with the principal's identity stripped. The attestation principal is **payload-level domain
data**, not channel-level provenance (cf. M3 Lot C stamping `engagementRef` into the `blocker.resolved`
payload, `track.ts:349-353`).

**Required fix (applied):** principal-bearing attested facts —
`comprehension?: { attestedBy/subject, dossierHash, sig? }` (+ `presenterBias` dropped to read-time, see §6).

## 2. Correlation keys — distinct, do not unify
`engagementRef` → an h2a **ENGAGEMENT** (the contract). The dossier is keyed on **`negotiationId`**
(`decision-dossier.ts:40,258`). An ENGAGEMENT is produced *within* a negotiation (1:many) — not
interchangeable. Keep both; the strongest join is **`dossierHash`** (what comprehension is attested against,
`handlers.ts:464`), `negotiationRef` the locator. Fix the §3.1 gloss; bind `dossierHash` into the fact.

## 3. Additivity & write path
Additivity correct (byte-identical hashing; same pattern as M3 Lot A). **D-B default wrong — recommend the
append kind now, not "only if".** `reviseDossier` is whole-`Dossier` read-modify-write (`track.ts:269-273`) →
lost-update when a bridge appends an artifact racing a human `context`/`options` edit. The M3 precedent already
rejected this (`blocker.resolve-external` is its own atomic kind, `contract.ts:212-216`). Use
`decision.add-artifact` (settles non-binding-outcome but **binding-gated**, `clientToken` idempotency).

## 4. The four defaults
- **D-A pointer:** right. Copy is a DS concern (snapshot at render), not a reason to duplicate authoritative
  h2a state in track's immutable log.
- **D-B write path:** change the default — append kind now.
- **D-C record markers:** right in intent, wrong in shape — principal-bearing facts, not anonymous booleans.
- **D-D DS-owned M5 contract:** right and correctly out of scope.

## 5. Scope discipline
Clean. M5/D5 + new h2a surface correctly out of build scope. **One omission:** §7 didn't test the
provenance-honesty property — add a test that the recorded artifact names the *decider* attester distinctly
from the *bridge* `prov.principal`. With D-B changed, §7.5 (CLI≡ingest parity) becomes mandatory.

## 6. Simpler alternative — hybrid is the right cut
"Correlate purely by `engagementRef`, store nothing h2a-derived, let the DS join at read time" is simpler and
**right for `presenterBiasFlagged`** (a live, re-derivable pure gate — recompute at render, don't freeze). It
**fails for comprehension**: comprehension is a point-in-time event against a specific `dossierHash`; once h2a's
dossier moves past H, a read-time join cannot reconstruct "the decider comprehended H at time T". **Keep the
comprehension attestation frozen (with principal + hash); drop presenter-bias to a read-time DS join.**

## Single most important correction
Replace the anonymous booleans with **principal-bearing attested facts**. The bridge is a signed *relay*; the
decider is the *attester*. The record must name the attester in the payload — or track silently asserts a
comprehension judgment on the decider's behalf (confused-deputy).

## Disposition
All applied to the doc v2: §3.1 `ComprehensionEvidence` (named subject + dossierHash + sig), presenter-bias
removed (read-time), §3.2 `decision.add-artifact` append kind, D-E correlation, §7 confused-deputy + parity
tests, §8 integration points.
