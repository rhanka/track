import {
  DomainError,
  type Gate,
  type ItemId,
  type Link,
  type Realization,
} from './item.js'
import type { ActorId, ProvenanceSignature } from '../events/types.js'
import type { PriorityAssessment } from './priority.js'

export type DecisionKind = Gate // a Decision's kind == the gate it settles (SPEC §2.10)
export type Outcome = 'pending' | 'go' | 'no-go' | 'deferred'

export interface Option {
  id: string
  title: string
  summary: string
  pros?: string[]
  cons?: string[]
}

export interface QAEntry {
  id: string
  question: string
  answer?: string
}

/**
 * Record-only evidence of ONE h2a comprehension attestation (M5 §3.1). Track RECORDS it; track
 * NEVER verifies it (the exact M3 `signed` posture). It NAMES the attester (`subject` = the DECIDER)
 * so the record is honest about WHO comprehended — DISTINCT from the channel `prov.principal` that
 * merely RELAYED the write (the load-bearing confused-deputy fix).
 */
export interface ComprehensionEvidence {
  subject: string // the principal who attested = the DECIDER (h2a actor.instance / NHI id)
  dossierHash: string // the hash that was attested — bound INTO the fact (no-hash attests nothing)
  h2aEventRef?: string // locator of the h2a journal attestation entry
  attestationHash?: string // the attestation body's own hash
  sig?: ProvenanceSignature // the recorded h2a signature (audit; never verified by track)
  at?: string // attested-at (h2a-supplied)
}

/**
 * A record-only pointer to an h2a decision dossier / a rendered view / a mockup (M5 §3.1). A
 * DISCRIMINATED UNION (a flat optional bag would let `kind:'h2a-decision-dossier'` exist with no
 * hash). `canonicalize()` drops `undefined` ⇒ a dossier WITHOUT `artifacts` hashes byte-identically
 * (frozen contract intact). Track never verifies an attestation or recomputes a rank.
 */
export type DossierArtifact =
  | {
      kind: 'h2a-decision-dossier'
      negotiationRef: string // the h2a NEGOTIATION id — the dossier locator (NOT Decision.engagementRef)
      dossierHash: string // canonical computeHash(H2ADecisionDossier) presented
      comprehension?: ComprehensionEvidence[] // record-only evidence of attestations (named principals)
      label?: string
    }
  | {
      kind: 'rendered-view' // an M5/D5-rendered embeddable view
      viewRef: string // stable id/URI of the DS-rendered view
      sourceDossierHash?: string
      label?: string
    }
  | { kind: 'mockup'; viewRef: string; label?: string }

/** Typed decision dossier (SPEC §2.7). `outcome` is NOT duplicated here (single source = the Decision). */
export interface Dossier {
  context: string
  options: Option[]
  qa: QAEntry[]
  selectedOptionId?: string
  recommendation?: { optionId: string; rationale: string }
  resultingSpecChange?: string
  decisionEvaluation?: PriorityAssessment // FROZEN priority snapshot at decision time
  // M5 (additive, record-only): pointers to an h2a decision dossier / rendered view / mockup. Appended
  // ONE-at-a-time by the `decision.add-artifact` kind — never a whole-dossier rewrite. Absent on every
  // pre-M5 dossier ⇒ zero hash change (canonicalize drops undefined).
  artifacts?: DossierArtifact[]
}

/** A Decision is a specialized Item (kind:"decision"): only realization (its prep) + outcome (SPEC §2.5). */
export interface DecisionState {
  id: ItemId
  kind: 'decision'
  title: string
  workspace: string
  realization: Realization
  decisionKind: DecisionKind
  targets: ItemId[]
  outcome: Outcome
  dossier: Dossier
  parentId?: ItemId
  sourceKey?: string
  body?: string
  links?: Link[]
  // Lot A (additive): `accountable` IS the decision sponsor (D6 resolved — supersedes the reserved
  // separate `sponsor` field). `engagementRef` links to an h2a ENGAGEMENT (the executable contract).
  accountable?: ActorId
  engagementRef?: string
}

export interface DecisionCreatedPayload {
  decisionKind: DecisionKind
  title: string
  workspace: string
  targets: ItemId[]
  dossier: Dossier
  parentId?: ItemId
  sourceKey?: string
  body?: string
  links?: Link[]
  accountable?: ActorId
  engagementRef?: string
}

// outcome machine (SPEC §2.6): pending → {go,no-go,deferred}; deferred → {go,no-go}; go/no-go terminal.
const OUTCOME_TRANSITIONS: Record<Outcome, ReadonlyArray<Outcome>> = {
  pending: ['go', 'no-go', 'deferred'],
  deferred: ['go', 'no-go'],
  go: [],
  'no-go': [],
}

export function assertOutcomeTransition(current: Outcome, to: Outcome): void {
  if (!OUTCOME_TRANSITIONS[current].includes(to)) {
    throw new DomainError(`illegal outcome transition ${current} -> ${to}`)
  }
}

export function isSettled(outcome: Outcome): boolean {
  return outcome === 'go' || outcome === 'no-go'
}

/** The `decision.add-artifact` payload (M5 §3.2) — appends ONE artifact to a decision's dossier. */
export interface AddArtifactPayload {
  decisionId: ItemId
  artifact: DossierArtifact
}

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** Validate ONE ComprehensionEvidence (fail-closed): subject + dossierHash are mandatory. */
function assertComprehensionEvidence(e: unknown, i: number): void {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) {
    throw new DomainError(`decision.add-artifact: comprehension[${i}] must be an object`)
  }
  const c = e as Record<string, unknown>
  if (!nonEmptyString(c['subject'])) {
    throw new DomainError(`decision.add-artifact: comprehension[${i}].subject (the attester) is required`)
  }
  if (!nonEmptyString(c['dossierHash'])) {
    throw new DomainError(`decision.add-artifact: comprehension[${i}].dossierHash is required (no-hash attests nothing)`)
  }
}

/**
 * Fail-closed validation + normalization of a `DossierArtifact` (M5 §3.1). Returns the validated
 * artifact (a defensive plain copy of the discriminated branch's known fields) or throws DomainError.
 * `h2a-decision-dossier` requires `negotiationRef`+`dossierHash`; `rendered-view`/`mockup` require
 * `viewRef`. An unknown `kind` is rejected (no flat optional bag, no silent forward).
 */
export function assertDossierArtifact(input: unknown): DossierArtifact {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DomainError('decision.add-artifact: artifact must be an object')
  }
  const a = input as Record<string, unknown>
  switch (a['kind']) {
    case 'h2a-decision-dossier': {
      if (!nonEmptyString(a['negotiationRef'])) {
        throw new DomainError("decision.add-artifact: an 'h2a-decision-dossier' requires a negotiationRef")
      }
      if (!nonEmptyString(a['dossierHash'])) {
        throw new DomainError("decision.add-artifact: an 'h2a-decision-dossier' requires a dossierHash")
      }
      let comprehension: ComprehensionEvidence[] | undefined
      if (a['comprehension'] !== undefined) {
        if (!Array.isArray(a['comprehension'])) {
          throw new DomainError('decision.add-artifact: comprehension must be an array')
        }
        a['comprehension'].forEach((e, i) => assertComprehensionEvidence(e, i))
        comprehension = a['comprehension'] as ComprehensionEvidence[]
      }
      return {
        kind: 'h2a-decision-dossier',
        negotiationRef: a['negotiationRef'],
        dossierHash: a['dossierHash'],
        ...(comprehension !== undefined ? { comprehension } : {}),
        ...(a['label'] !== undefined ? { label: a['label'] as string } : {}),
      }
    }
    case 'rendered-view': {
      if (!nonEmptyString(a['viewRef'])) {
        throw new DomainError("decision.add-artifact: a 'rendered-view' requires a viewRef")
      }
      return {
        kind: 'rendered-view',
        viewRef: a['viewRef'],
        ...(a['sourceDossierHash'] !== undefined ? { sourceDossierHash: a['sourceDossierHash'] as string } : {}),
        ...(a['label'] !== undefined ? { label: a['label'] as string } : {}),
      }
    }
    case 'mockup': {
      if (!nonEmptyString(a['viewRef'])) {
        throw new DomainError("decision.add-artifact: a 'mockup' requires a viewRef")
      }
      return {
        kind: 'mockup',
        viewRef: a['viewRef'],
        ...(a['label'] !== undefined ? { label: a['label'] as string } : {}),
      }
    }
    default:
      throw new DomainError(`decision.add-artifact: unknown artifact kind "${String(a['kind'])}"`)
  }
}
