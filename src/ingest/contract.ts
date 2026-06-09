// Lot v2.3b-1 — the neutral `WorkEvent` ingest contract (M2b write seam, channel ①).
//
// A WorkEvent is a transport-agnostic envelope: it carries the WHAT (kind + payload); the WHO
// (by/workspace/prov/capability) comes from the ingest CONTEXT, never the event (see v2.3b-DESIGN.md §2).
// One WorkEvent ⇒ one Track command. This module is the SINGLE SOURCE of the write enums (so the CLI's
// `oneOf` checks and the mapper cannot diverge on accepted values) and of the per-kind payload schema.

export const INGEST_CONTRACT_VERSION = '1.0.0'

// --- write enums (shared with src/cli/index.ts) ------------------------------------------------------
export const ITEM_KINDS = ['feature', 'bug', 'chore'] as const
export const SPEC_TARGETS = ['to-specify', 'specified'] as const
export const REALIZE_TARGETS = ['in-progress', 'done', 'cancelled'] as const
export const DECISION_KINDS = ['orientation', 'commitment'] as const
export const OUTCOMES = ['go', 'no-go', 'deferred'] as const
export const GATES = ['orientation', 'commitment'] as const
export const DISPOSITIONS = ['required', 'skipped', 'not-applicable'] as const
export const BLOCKER_KINDS = ['decision', 'dependency'] as const
export const RESOLUTION_RULES = ['linked-done', 'linked-accepted', 'manual'] as const
export const EVIDENCE_KINDS = ['unit', 'integration', 'e2e', 'manual'] as const
export const RESULTS = ['pass', 'fail'] as const
export const BLOCKER_SCOPES = ['intra', 'extra'] as const // Lot A — dependency blocker scope

// --- kinds -------------------------------------------------------------------------------------------
export const WORK_EVENT_KINDS = [
  'item.create',
  'item.spec',
  'item.realize',
  'decision.create',
  'decision.dossier',
  'decision.outcome',
  'decision.disposition',
  'acceptance.criterion',
  'acceptance.link',
  'acceptance.run',
  'acceptance.waive',
  'priority.assess',
  'blocker.raise',
  'blocker.resolve',
  'blocker.resolve-external',
] as const
export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number]

export interface WorkEvent {
  /** Contract major. Unknown major ⇒ fail-closed reject; unknown minor degrades to "unknown kind". */
  v: 1
  kind: WorkEventKind
  /** Validated per-kind by WORK_EVENT_SCHEMA (required + type + enum + NO unknown fields). */
  payload: Record<string, unknown>
  /**
   * Optional delivery idempotency key (v2.3c). If a prior event with this token is already in the log,
   * ingest SKIPS this WorkEvent (returning its original assigned id). The producer owns token uniqueness.
   * This is a delivery key, not a WHO/trust field — so it is allowed on the envelope (unlike actor/sponsor).
   */
  clientToken?: string
}

/** The only allowed envelope keys — any other (actor/sponsor/proposed/…) is rejected fail-closed: the
 *  WHO and the trust level come from the ingest CONTEXT (channel), never per-event (v2.3b-DESIGN.md §2).
 *  `clientToken` is the one exception — a delivery idempotency key, not a trust field (v2.3c). */
export const WORK_EVENT_ENVELOPE_KEYS = ['v', 'kind', 'payload', 'clientToken'] as const

// --- per-kind payload schema -------------------------------------------------------------------------
export type FieldType = 'string' | 'number' | 'string[]' | 'object'

export interface FieldSpec {
  type: FieldType
  required: boolean
  /** Allowed values for a string field (else any string). */
  enum?: readonly string[]
}

/**
 * How a kind settles state — drives the binding gate in `ingest` (v2.3b-2):
 *  - `never`            non-binding (creation/preparation)
 *  - `always`           binding — requires `auth ∈ {local-user, signed}`
 *  - `realize-terminal` binding iff `payload.to ∈ {done, cancelled}` (a false `done` is a false-green)
 *  - `evidence`         machine evidence (a CI run) — gated like binding on an unauthenticated channel
 *                       (which denies all settling writes), allowed on local-user/signed
 */
export type Settles = 'never' | 'always' | 'realize-terminal' | 'evidence'

export interface KindSchema {
  /** The Track facade method this kind maps to (1:1). */
  method: string
  settles: Settles
  fields: Record<string, FieldSpec>
}

const str = (required: boolean, e?: readonly string[]): FieldSpec =>
  e ? { type: 'string', required, enum: e } : { type: 'string', required }
const num = (required: boolean): FieldSpec => ({ type: 'number', required })

export const WORK_EVENT_SCHEMA: Record<WorkEventKind, KindSchema> = {
  'item.create': {
    method: 'createItem',
    settles: 'never',
    fields: {
      kind: str(true, ITEM_KINDS),
      title: str(true),
      workspace: str(true),
      parentId: str(false),
      body: str(false),
      sourceKey: str(false),
      accountable: str(false),
      responsible: { type: 'string[]', required: false },
      engagementRef: str(false),
    },
  },
  'item.spec': {
    method: 'setSpec',
    settles: 'never',
    fields: { itemId: str(true), to: str(true, SPEC_TARGETS) },
  },
  'item.realize': {
    method: 'setRealization',
    settles: 'realize-terminal',
    fields: { itemId: str(true), to: str(true, REALIZE_TARGETS) },
  },
  'decision.create': {
    method: 'createDecision',
    settles: 'never',
    fields: {
      decisionKind: str(true, DECISION_KINDS),
      title: str(true),
      workspace: str(true),
      targets: { type: 'string[]', required: true },
      dossier: { type: 'object', required: true },
      parentId: str(false),
      body: str(false),
      sourceKey: str(false),
      accountable: str(false),
      engagementRef: str(false),
    },
  },
  'decision.dossier': {
    method: 'reviseDossier',
    settles: 'never',
    fields: { decisionId: str(true), dossier: { type: 'object', required: true } },
  },
  'decision.outcome': {
    method: 'setOutcome',
    settles: 'always',
    fields: { decisionId: str(true), to: str(true, OUTCOMES) },
  },
  'decision.disposition': {
    method: 'setDisposition',
    settles: 'never',
    fields: {
      itemId: str(true),
      gate: str(true, GATES),
      disposition: str(true, DISPOSITIONS),
      reason: str(false),
    },
  },
  'acceptance.criterion': {
    method: 'addCriterion',
    settles: 'never',
    fields: { itemId: str(true), statement: str(true) },
  },
  'acceptance.link': {
    method: 'linkEvidence',
    settles: 'never',
    fields: { criterionId: str(true), kind: str(true, EVIDENCE_KINDS), locator: str(true) },
  },
  'acceptance.run': {
    method: 'recordRun',
    settles: 'evidence',
    fields: {
      evidenceId: str(true),
      commit: str(true),
      env: str(true),
      runner: str(true),
      result: str(true, RESULTS),
    },
  },
  'acceptance.waive': {
    method: 'waive',
    settles: 'always',
    fields: { criterionId: str(true), reason: str(true) },
  },
  'priority.assess': {
    method: 'assessPriority',
    settles: 'never',
    fields: {
      itemId: str(true),
      userBusinessValue: num(true),
      timeCriticality: num(true),
      riskReductionOpportunityEnablement: num(true),
      jobSize: num(true),
    },
  },
  'blocker.raise': {
    method: 'openBlocker',
    settles: 'never',
    fields: {
      targetId: str(true),
      kind: str(true, BLOCKER_KINDS),
      ref: str(false), // optional: an `extra`-scope dependency omits the local ref (uses engagementRef)
      reason: str(false),
      resolutionRule: str(false, RESOLUTION_RULES),
      owner: str(false),
      scope: str(false, BLOCKER_SCOPES),
      engagementRef: str(false),
    },
  },
  'blocker.resolve': {
    method: 'resolveBlocker',
    settles: 'always',
    fields: { blockerId: str(true) },
  },
  'blocker.resolve-external': {
    method: 'resolveExternalDependency',
    settles: 'always', // a settling write — the bridge channel must be authenticated (signed/local-user)
    fields: { engagementRef: str(true) },
  },
}
