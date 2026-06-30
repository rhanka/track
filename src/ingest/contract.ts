// Lot v2.3b-1 — the neutral `WorkEvent` ingest contract (M2b write seam, channel ①).
//
// A WorkEvent is a transport-agnostic envelope: it carries the WHAT (kind + payload); the WHO
// (by/workspace/prov/capability) comes from the ingest CONTEXT, never the event (see v2.3b-DESIGN.md §2).
// One WorkEvent ⇒ one Track command. This module is the SINGLE SOURCE of the write enums (so the CLI's
// `oneOf` checks and the mapper cannot diverge on accepted values) and of the per-kind payload schema.

// 1.6.0 — A2 role:'stream' (DESIGN wp-codes-and-stream-role §A2): TWO additive changes — (1) a new ITEM_ROLES
// value `'stream'` (a third container category, accepted on `item.create`'s `role` enum); (2) one ADDITIVE new
// WorkEvent kind `item.set-role` → the persisted `item.role-changed` event (a BOUNDED container↔container role
// mutation `workpackage↔stream`; LWW, `settles:'always'`). MINOR bump (a new optional enum value + a new
// optional kind; no kind removed, no required field added to an existing kind, envelope keys unchanged; old
// producers never send the new value/kind and still validate; an old reader ignores `item.role-changed`).
// 1.5.0 — WP-codes (DESIGN wp-codes A1): one ADDITIVE new WorkEvent kind `item.assign-code` → the persisted
// `item.code-assigned` event (a DURABLE display `code` on a role-container; LWW, `settles:'always'`). MINOR
// bump (a new optional kind; no kind removed, no required field added to an existing kind, envelope keys
// unchanged; old producers never send it and still validate).
// 1.4.0 — cross-workspace WP reorg (DESIGN R2): one ADDITIVE new WorkEvent kind `item.restructure` — a
// DISTINCT, DEFAULT-DENIED capability kind that maps to the SAME persisted `item.reparented` event (additive
// `planHash`/`restructureRef` payload). MINOR bump (a new optional kind; no kind removed, no required field
// added to an existing kind, envelope keys unchanged; old producers never send it and still validate). The
// authority is a CONTEXT-level grant (`authorize`'s deny-explicit branch), NOT a payload flag.
// 1.3.0 — demand lifecycle (Mode A): six ADDITIVE new WorkEvent kinds (`demand.raise`/`demand.claim`/
// `demand.agree`/`demand.disposition`/`spec.claim`/`spec.abandon`). MINOR bump (new optional kinds; no kind
// removed, no required field added, envelope keys unchanged; old producers never send them and still validate).
// 1.2.0 — acceptance-freshness lifecycle: two ADDITIVE new WorkEvent kinds (`item.anchor`→
// `realization.anchored`, `item.consolidate`→the consolidate verb). MINOR bump (new optional kinds; no kind
// removed, no required field added, envelope keys unchanged; old producers never send them and still validate).
// 1.1.0 — seam v0 FREEZE: two ADDITIVE optional producer fields (artifactLocator on scope.verification,
// caller-supplied evidenceId on acceptance.link).
export const INGEST_CONTRACT_VERSION = '1.6.0'

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
export const ITEM_ROLES = ['workpackage', 'spec-phase', 'stream'] as const // Scope §B(a) / A2 — the 3 container markers
// A2 — the BOUNDED `item.set-role` target enum: a role mutation is container↔container ONLY (`workpackage↔
// stream`), NEVER to/from a leaf (role undefined) nor `spec-phase`. The mapper rejects any other `to` value.
export const ROLE_CHANGE_TARGETS = ['workpackage', 'stream'] as const
export const VERDICTS = ['clean', 'violation', 'conditional'] as const // Scope §B(c) — path verdict
// Demand lifecycle (Mode A) — the demand type (carried to the item kind) + the disposition off-ramp outcome.
export const DEMAND_TYPES = ['feature', 'defect', 'chore'] as const
export const DISPOSITION_OUTCOMES = ['rejected', 'duplicate', 'parked'] as const

// --- kinds -------------------------------------------------------------------------------------------
export const WORK_EVENT_KINDS = [
  'item.create',
  'item.reparent',
  'item.spec',
  'item.realize',
  'decision.create',
  'decision.dossier',
  'decision.add-artifact',
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
  'scope.verification', // Scope §B(c) — record a path-scope VerificationRun (evidence-only)
  'scope.declare', // Scope §B(a) — declare INERT path-scope globs on a WP/spec-phase
  'item.assign-code', // WP-codes (DESIGN A1) — assign/replace a DURABLE display code on a WP/spec-phase
  'item.set-role', // A2 — BOUNDED container↔container role mutation (workpackage↔stream) → item.role-changed
  'item.spec-amend', // M5 (canevas) — record a LIVE spec amendment (verbatim JsonPatch) on an item
  'item.anchor', // Acceptance-freshness — re-point an item's realization ANCHOR commit (→ realization.anchored)
  'item.consolidate', // Acceptance-freshness — the squash/rebase heal: re-anchor + re-stamp pass runs at mergeCommit
  // Demand lifecycle (Mode A) — the demand aggregate write path + the spec-attempt facts (DESIGN §Events).
  'demand.raise', // → demand.raised (NON-binding: any channel may capture the t=0 issue)
  'demand.claim', // → demand.qualifying-started (raised|parked → qualifying)
  'demand.agree', // → demand.agreed + item.created (1..N) — the ATOMIC promotion
  'demand.disposition', // → demand.disposition (qualifying → rejected|duplicate|parked)
  'spec.claim', // → spec.started (durable WHO-is-attempting fact on an item)
  'spec.abandon', // → spec.abandoned (durable explicit-abandon fact: who/why)
  // Cross-workspace WP reorg (DESIGN R2) — a DISTINCT, DEFAULT-DENIED capability kind. Maps to the SAME
  // persisted `item.reparented` event (additive planHash/restructureRef payload); the cross-workspace move
  // is authorized ONLY on a channel that EXPLICITLY grants it (authorize deny-explicit branch).
  'item.restructure', // → item.reparented (cross-workspace move, plan-scoped)
] as const
export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number]

/**
 * DESIGN R2 — the DEFAULT-DENIED capability kinds. `authorize` carries a DEDICATED deny-explicit branch for
 * these: a channel may run one ONLY when `ctx.allowedKinds` EXPLICITLY grants it. We do NOT rely on the
 * `allowedKinds` allowlist (it defaults to "permit everything" and is never set in prod) — we ADD an explicit
 * refusal. Kept here (the single source of the write enums) but NOT re-exported from the `./ingest` barrel
 * (the capability is internal to the seam).
 */
export const RESTRUCTURE_KINDS: ReadonlySet<WorkEventKind> = new Set<WorkEventKind>(['item.restructure'])

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
export type FieldType = 'string' | 'number' | 'string[]' | 'object' | 'object[]'

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
      role: str(false, ITEM_ROLES), // Workpackages §2 / Scope §B(a) — container marker
      scope: { type: 'object', required: false }, // Scope §B(a) — INERT path globs; shape re-asserted in the facade
      body: str(false),
      sourceKey: str(false),
      accountable: str(false),
      responsible: { type: 'string[]', required: false },
      engagementRef: str(false),
    },
  },
  'item.reparent': {
    // Workpackages §2 — move/detach an item. Binding (`always`): moving work between WPs is
    // trust-sensitive ⇒ requires auth ∈ {local-user, signed}. parentId absent ⇒ detach to root.
    method: 'reparentItem',
    settles: 'always',
    fields: { itemId: str(true), parentId: str(false) },
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
  'decision.add-artifact': {
    // M5 — append ONE record-only DossierArtifact to a decision's dossier. Binding (`always`): a false
    // comprehension marker is trust-sensitive ⇒ requires auth ∈ {local-user, signed}. The `artifact`
    // discriminated-union SHAPE is validated fail-closed in the facade (assertDossierArtifact); the
    // envelope schema only checks it is an object (the flat FieldSpec cannot express a union).
    method: 'addDecisionArtifact',
    settles: 'always',
    fields: { decisionId: str(true), artifact: { type: 'object', required: true } },
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
    // Seam v0 (M2=B) — `evidenceId` is an OPTIONAL caller-supplied DETERMINISTIC evidence key. Present ⇒
    // linkEvidence honors it (so the harness can reference it on a same-stream `acceptance.run` without a
    // two-phase read); absent ⇒ the shipped server-mint behavior (back-compat). Non-empty re-asserted in
    // the facade. Additive optional — old callers omit it and still validate.
    method: 'linkEvidence',
    settles: 'never',
    fields: { criterionId: str(true), kind: str(true, EVIDENCE_KINDS), locator: str(true), evidenceId: str(false) },
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
  'scope.verification': {
    // Scope §B(c) — record ONE path-scope VerificationRun (evidence-only). `Settles:'evidence'` ⇒ DENIED
    // on an unauthenticated channel (like acceptance.run); a signed/local-user channel (the harness/bridge)
    // admits it. The flat FieldSpec checks presence/type/enum; the verdict enum + `violations` element
    // types are re-asserted fail-closed in the facade (assertVerificationRun). track NEVER glob-matches.
    method: 'recordVerification',
    settles: 'evidence',
    fields: {
      runId: str(true),
      runner: str(true),
      commit: str(true),
      verdict: str(true, VERDICTS),
      env: str(false),
      wpRef: str(false),
      violations: { type: 'string[]', required: false },
      // Seam v0 (S2) — an OPTIONAL immutable producer-owned locator to the full VerificationRun JSON. Stored
      // OPAQUE (track never fetches/parses); non-empty re-asserted in the facade (assertVerificationRun),
      // drop-when-absent (hash-minimal). Additive optional — old producers omit it and still validate.
      artifactLocator: str(false),
    },
  },
  'scope.declare': {
    // Scope §B(a) — declare INERT path-scope globs on a WP/spec-phase. Binding (`always`): a scope
    // declaration governs the harness path verdict ⇒ trust-sensitive, requires auth ∈ {local-user, signed}.
    // The flat FieldSpec checks `scope` is an object; the `{allowed?,forbidden?,conditional?}` string[]
    // shape is re-asserted fail-closed in the facade (assertScopeDecl). track STORES globs, NEVER matches.
    method: 'declareScope',
    settles: 'always',
    fields: { itemId: str(true), scope: { type: 'object', required: true } },
  },
  'item.assign-code': {
    // WP-codes (DESIGN A1) — assign/replace a DURABLE display `code` on a role-container (WP/spec-phase).
    // Binding (`always`): re-pointing a stable public handle is trust-sensitive ⇒ requires auth ∈
    // {local-user, signed} (calque item.reparent/scope.declare). The facade (Track.assignCode) re-checks
    // the item is a role-container, the code is non-empty, AND roster-global uniqueness (no OTHER root
    // container holds this code) — fail-closed, AND re-asserted under the lock (F2). LWW: re-assignable.
    method: 'assignCode',
    settles: 'always',
    fields: { itemId: str(true), code: str(true) },
  },
  'item.set-role': {
    // A2 (DESIGN wp-codes-and-stream-role §A2) — BOUNDED container↔container role mutation. `to` is enum
    // {workpackage, stream} ONLY (a leaf/undefined and spec-phase are NOT reachable — the mapper rejects
    // them). Binding (`always`): re-classifying a container re-numbers the roster + re-legalizes its
    // neighborhood ⇒ trust-sensitive, requires auth ∈ {local-user, signed} (calque item.reparent). The
    // facade (Track.setRole) re-checks the item is a mutable container AND re-runs `assertRoleNesting` for
    // the item-under-its-parent AND for EVERY child (a role-change re-legalizes the whole neighborhood),
    // fail-closed BEFORE any append. Folds `item.role = to` (LWW) → `item.role-changed`.
    method: 'setRole',
    settles: 'always',
    fields: { itemId: str(true), to: str(true, ROLE_CHANGE_TARGETS) },
  },
  'item.spec-amend': {
    // M5 (canevas) — record ONE owner-approved LIVE spec amendment. Binding (`always`): an amendment to the
    // spec is trust-sensitive ⇒ requires auth ∈ {local-user, signed}. The `patch` JsonPatch SHAPE (an array
    // of `{op,path,…}`) is re-asserted fail-closed in the facade (assertSpecAmend); the flat FieldSpec only
    // checks `patch` is an object/array, `baseHash`/`resultHash` present. track records the patch VERBATIM,
    // NEVER applies/validates the patch semantics — baseHash/resultHash are opaque integrity tags.
    method: 'amendSpec',
    settles: 'always',
    fields: {
      itemId: str(true),
      baseHash: str(true),
      patch: { type: 'object[]', required: true }, // a JsonPatch — an array of `{op,path,…}` ops
      resultHash: str(true),
      decisionId: str(false),
      liveDocRef: str(false),
      proposalRef: str(false),
      summary: str(false),
    },
  },
  'item.anchor': {
    // Acceptance-freshness — re-point an item's realization ANCHOR commit (→ `realization.anchored`). Binding
    // (`evidence`): an attributable producer claim of WHERE the work landed, like `acceptance.run` — denied on
    // an unauthenticated channel, admitted on local-user/signed. `reason` is audit metadata (realize|consolidate).
    method: 'anchorRealization',
    settles: 'evidence',
    fields: { itemId: str(true), commit: str(true), reason: str(false, ['realize', 'consolidate']) },
  },
  'item.consolidate': {
    // Acceptance-freshness — the squash/rebase HEAL: re-anchor each done item on the mergeCommit + re-stamp its
    // pass runs there. Binding (`always`): re-anchoring a merge is trust-sensitive (like `item.reparent`) ⇒
    // requires auth ∈ {local-user, signed}. `items` are CALLER-AUTHORITATIVE (track has no branch→item link).
    method: 'consolidate',
    settles: 'always',
    fields: { items: { type: 'string[]', required: true }, mergeCommit: str(true) },
  },
  'demand.raise': {
    // Demand lifecycle (Mode A) — capture a demand (DESIGN §Events). NON-binding (`never`): the "nothing
    // untracked" guarantee — any channel may capture the t=0 issue (an unauthenticated channel included).
    // The `type`/`raw`/`source`/`concerns`/`links` SHAPES are re-asserted fail-closed in the facade
    // (assertDemandRaised); the flat FieldSpec checks presence/type/enum. `workspace` pins the channel.
    method: 'raiseDemand',
    settles: 'never',
    fields: {
      type: str(true, DEMAND_TYPES),
      raw: { type: 'object', required: true },
      source: { type: 'object', required: true },
      handler: str(false), // resolved by precedence in the facade (ctx.handler ?? prov.principal ?? by)
      workspace: str(true),
      sourceKey: str(false),
      concerns: { type: 'object', required: false },
      links: { type: 'object[]', required: false },
    },
  },
  'demand.claim': {
    // Demand lifecycle (Mode A) — claim a demand into qualifying (raised|parked → qualifying). Binding
    // (`always`): a settling lifecycle write ⇒ requires auth ∈ {local-user, signed}.
    method: 'claimDemand',
    settles: 'always',
    fields: { demandId: str(true), handler: str(false), leaseId: str(false) },
  },
  'demand.agree': {
    // Demand lifecycle (Mode A) — the ATOMIC promotion: demand.agreed + item.created (1..N) in one batch.
    // Binding (`always`): agreeing work onto the backlog is trust-sensitive ⇒ auth ∈ {local-user, signed}.
    // `items` is an object[] of `{title, body?, sourceKey?, links?}`; the facade builds the item.created(s).
    method: 'agreeDemand',
    settles: 'always',
    fields: {
      demandId: str(true),
      handler: str(false),
      items: { type: 'object[]', required: true },
      qualification: str(false),
      leaseId: str(false),
    },
  },
  'demand.disposition': {
    // Demand lifecycle (Mode A) — the recorded qualification off-ramp (qualifying → rejected|duplicate|
    // parked). Binding (`always`). The `duplicateOf` {kind,id} SHAPE + same-workspace/non-self containment
    // is re-asserted in the facade; the flat FieldSpec checks the `outcome` enum + `reason` presence.
    method: 'disposeDemand',
    settles: 'always',
    fields: {
      demandId: str(true),
      outcome: str(true, DISPOSITION_OUTCOMES),
      handler: str(false),
      reason: str(true),
      duplicateOf: { type: 'object', required: false },
      parkedUntil: str(false),
      leaseId: str(false),
    },
  },
  'spec.claim': {
    // Demand lifecycle (Mode A) — a durable WHO-is-attempting-the-spec fact on an item. Binding (`always`).
    method: 'startSpec',
    settles: 'always',
    fields: { itemId: str(true), handler: str(false), leaseId: str(false), attemptId: str(false) },
  },
  'spec.abandon': {
    // Demand lifecycle (Mode A) — the durable explicit-abandon fact (who/why), distinct from a silent lease
    // timeout (ephemeral, Build 2). Binding (`always`).
    method: 'abandonSpec',
    settles: 'always',
    fields: { itemId: str(true), handler: str(false), reason: str(true), leaseId: str(false) },
  },
  'item.restructure': {
    // Cross-workspace WP reorg (DESIGN R2/R2b) — the DEFAULT-DENIED cross-workspace move. Maps to
    // `restructureReparent`, which emits the SAME persisted `item.reparented` event (additive planHash/
    // restructureRef). Binding (`always`): moving work between workspaces is the MOST trust-sensitive write ⇒
    // requires auth ∈ {local-user, signed} AND the explicit `item.restructure` capability grant (authorize).
    // `planHash` is the AUTHORIZATION SCOPE: the apply verifies each {itemId→parentId} edge against the
    // ratified plan; at the seam the CHILD is pinned to ctx.workspace (R2b — a W-channel can only pull-into/
    // push-out-of W, never rearrange foreign X↔Y). The PARENT may be cross-workspace (the whole point).
    method: 'restructureReparent',
    settles: 'always',
    fields: { itemId: str(true), parentId: str(true), planHash: str(true), restructureRef: str(false) },
  },
}
