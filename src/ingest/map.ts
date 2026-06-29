// Lot v2.3b-1 — pure `WorkEvent` → Track-command mapper. Validates an envelope against the shared
// schema (fail-closed: unknown major / kind / field, missing required, wrong type, bad enum) and builds
// the positional argument tuple for the Track method. Pure and total: no I/O, no state, no append. The
// application + workspace/binding authorization (which need folded state) live in `ingest` (v2.3b-2).

import {
  WORK_EVENT_ENVELOPE_KEYS,
  WORK_EVENT_SCHEMA,
  type FieldSpec,
  type Settles,
  type WorkEvent,
  type WorkEventKind,
} from './contract.js'

/** A validated, normalized command ready for `ingest` to authorize and apply. */
export interface MappedCommand {
  kind: WorkEventKind
  method: string
  settles: Settles
  /** The validated payload (only schema-allowed fields, correct types). */
  payload: Readonly<Record<string, unknown>>
  /** Positional arguments to spread into the Track method. */
  args: readonly unknown[]
  /** Optional delivery idempotency key (v2.3c). */
  clientToken?: string
}

const MAX_CLIENT_TOKEN = 256

/** A fail-closed rejection of a malformed/illegal WorkEvent (distinct from a domain error). */
export class IngestError extends Error {
  override readonly name = 'IngestError'
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkType(kind: WorkEventKind, field: string, spec: FieldSpec, v: unknown): void {
  const bad = (want: string): never => {
    throw new IngestError(`${kind}.${field}: expected ${want}`)
  }
  switch (spec.type) {
    case 'string':
      if (typeof v !== 'string') bad('a string')
      if (spec.enum && !spec.enum.includes(v as string)) {
        throw new IngestError(`${kind}.${field}: must be one of ${spec.enum.join('|')} (got "${String(v)}")`)
      }
      return
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) bad('a finite number')
      return
    case 'string[]':
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) bad('a string[]')
      return
    case 'object':
      if (!isPlainObject(v)) bad('an object')
      return
    case 'object[]':
      if (!Array.isArray(v) || !v.every((x) => isPlainObject(x))) bad('an object[]')
      return
  }
}

/** Validate envelope + payload against the schema. Throws IngestError on any violation. */
function validate(ev: WorkEvent): {
  kind: WorkEventKind
  payload: Record<string, unknown>
  clientToken: string | undefined
} {
  if (!isPlainObject(ev)) throw new IngestError('WorkEvent must be an object')
  // Reject unknown envelope keys (fail-closed): no per-event actor/sponsor/proposed — the WHO/trust come
  // from the channel context, not the event.
  for (const key of Object.keys(ev)) {
    if (!(WORK_EVENT_ENVELOPE_KEYS as readonly string[]).includes(key)) {
      throw new IngestError(`unknown WorkEvent envelope key "${key}" (allowed: ${WORK_EVENT_ENVELOPE_KEYS.join(', ')})`)
    }
  }
  if ((ev as { v?: unknown }).v !== 1) {
    throw new IngestError(`unsupported WorkEvent contract major (expected v:1, got ${String((ev as { v?: unknown }).v)})`)
  }
  const clientToken = (ev as { clientToken?: unknown }).clientToken
  if (clientToken !== undefined && (typeof clientToken !== 'string' || clientToken.length === 0 || clientToken.length > MAX_CLIENT_TOKEN)) {
    throw new IngestError(`clientToken must be a non-empty string of at most ${MAX_CLIENT_TOKEN} chars`)
  }
  const kind = ev.kind
  const schema = (WORK_EVENT_SCHEMA as Record<string, (typeof WORK_EVENT_SCHEMA)[WorkEventKind]>)[kind]
  if (schema === undefined) throw new IngestError(`unknown WorkEvent kind "${String(kind)}"`)
  const payload = ev.payload
  if (!isPlainObject(payload)) throw new IngestError(`${kind}: payload must be an object`)

  // Reject unknown fields (fail-closed — never silently forward).
  for (const key of Object.keys(payload)) {
    if (!(key in schema.fields)) throw new IngestError(`${kind}: unknown payload field "${key}"`)
  }
  // Required presence + type + enum.
  for (const [field, spec] of Object.entries(schema.fields)) {
    const v = payload[field]
    if (v === undefined) {
      if (spec.required) throw new IngestError(`${kind}: missing required field "${field}"`)
      continue
    }
    checkType(kind, field, spec, v)
  }
  return { kind, payload, clientToken: clientToken as string | undefined }
}

/** Validate a WorkEvent and produce its mapped Track command. Pure; throws IngestError on any violation. */
export function mapWorkEvent(ev: WorkEvent): MappedCommand {
  const { kind, payload: p, clientToken } = validate(ev)
  const { method, settles } = WORK_EVENT_SCHEMA[kind]
  const opt = (k: string): Record<string, unknown> => (p[k] !== undefined ? { [k]: p[k] } : {})

  let args: readonly unknown[]
  switch (kind) {
    case 'item.create':
      // createItem(ItemCreatedPayload) — validated payload already IS the (links-free) shape.
      args = [{ ...p }]
      break
    case 'item.reparent':
      // reparentItem(itemId, parentId?) — parentId is undefined when absent (detach to root).
      args = [p['itemId'], p['parentId']]
      break
    case 'item.spec':
      args = [p['itemId'], p['to']]
      break
    case 'item.realize':
      args = [p['itemId'], p['to']]
      break
    case 'decision.create':
      args = [{ ...p }]
      break
    case 'decision.dossier':
      args = [p['decisionId'], p['dossier']]
      break
    case 'decision.add-artifact':
      // addDecisionArtifact(decisionId, artifact, clientToken?) — the union shape is validated in the
      // facade (fail-closed). clientToken is threaded by `ingest` via withClientToken, not as an arg.
      args = [p['decisionId'], p['artifact']]
      break
    case 'decision.outcome':
      args = [p['decisionId'], p['to']]
      break
    case 'decision.disposition':
      // setDisposition(itemId, gate, disposition, reason?) — pass reason as-is (undefined if absent).
      args = [p['itemId'], p['gate'], p['disposition'], p['reason']]
      break
    case 'acceptance.criterion':
      args = [p['itemId'], p['statement']]
      break
    case 'acceptance.link':
      // linkEvidence(criterionId, kind, locator, evidenceId?) — the OPTIONAL caller-supplied deterministic
      // evidence key (M2=B) is undefined when absent (⇒ the facade mints server-side, back-compat).
      args = [p['criterionId'], p['kind'], p['locator'], p['evidenceId']]
      break
    case 'acceptance.run':
      args = [p['evidenceId'], { commit: p['commit'], env: p['env'], runner: p['runner'], result: p['result'] }]
      break
    case 'acceptance.waive':
      args = [p['criterionId'], p['reason']]
      break
    case 'priority.assess':
      args = [
        p['itemId'],
        {
          userBusinessValue: p['userBusinessValue'],
          timeCriticality: p['timeCriticality'],
          riskReductionOpportunityEnablement: p['riskReductionOpportunityEnablement'],
          jobSize: p['jobSize'],
        },
      ]
      break
    case 'blocker.raise':
      // openBlocker(OpenBlockerInput) — reason defaults to '' to match the CLI (`opt(reason) ?? ''`).
      // `ref` is conditional (omitted for an `extra` dep); the Track method enforces the intra/extra rules.
      args = [
        {
          targetId: p['targetId'],
          kind: p['kind'],
          ...opt('ref'),
          reason: p['reason'] ?? '',
          ...opt('resolutionRule'),
          ...opt('owner'),
          ...opt('scope'),
          ...opt('engagementRef'),
        },
      ]
      break
    case 'blocker.resolve':
      args = [p['blockerId']]
      break
    case 'blocker.resolve-external':
      // resolveExternalDependency(engagementRef, {workspace}) — the workspace pin is supplied by `ingest`
      // from the channel context (containment), not the WorkEvent.
      args = [p['engagementRef']]
      break
    case 'scope.verification':
      // recordVerification(payload, {workspace}, clientToken?) — the validated payload IS the run shape;
      // the workspace pin (for the wpRef-absent synthetic aggregate) is supplied by `ingest` from the
      // channel context, and clientToken is threaded via withClientToken (not an arg). Scope §B(c).
      args = [{ ...p }]
      break
    case 'scope.declare':
      // declareScope(itemId, scope, clientToken?) — the `scope` object's {allowed?,forbidden?,conditional?}
      // shape is re-asserted in the facade (assertScopeDecl); clientToken is threaded via withClientToken
      // (not an arg). Scope §B(a).
      args = [p['itemId'], p['scope']]
      break
    case 'item.assign-code':
      // assignCode(itemId, code, clientToken?) — the role-container check + non-empty + roster-global
      // uniqueness are re-asserted in the facade; clientToken is threaded via withClientToken (not an arg).
      args = [p['itemId'], p['code']]
      break
    case 'item.spec-amend':
      // amendSpec(itemId, amend, clientToken?) — the validated payload IS the amendment shape; its JsonPatch
      // + baseHash/resultHash are re-asserted (assertSpecAmend) and recorded VERBATIM in the facade.
      // clientToken is threaded via withClientToken (not an arg). M5 (canevas).
      args = [p['itemId'], { ...p }]
      break
    case 'item.anchor':
      // anchorRealization(itemId, commit, reason?, clientToken?) — clientToken is threaded via
      // withClientToken (not an arg). Acceptance-freshness lifecycle.
      args = [p['itemId'], p['commit'], p['reason']]
      break
    case 'item.consolidate':
      // consolidate(items, mergeCommit, clientToken?) — items are CALLER-AUTHORITATIVE; clientToken is
      // threaded via withClientToken (not an arg). Acceptance-freshness lifecycle (the squash/rebase heal).
      args = [p['items'], p['mergeCommit']]
      break
    case 'demand.raise':
      // raiseDemand({type, raw, source, handler?, workspace, sourceKey?, concerns?, links?}) — the payload
      // SHAPE is re-asserted fail-closed in the facade (assertDemandRaised). Demand lifecycle (Mode A).
      args = [{ ...p }]
      break
    case 'demand.claim':
      // claimDemand(demandId, {handler?, leaseId?}) — Demand lifecycle (Mode A).
      args = [p['demandId'], { ...opt('handler'), ...opt('leaseId') }]
      break
    case 'demand.agree':
      // agreeDemand(demandId, {handler?, items, qualification?, leaseId?}) — the ATOMIC promotion (Mode A).
      args = [p['demandId'], { items: p['items'], ...opt('handler'), ...opt('qualification'), ...opt('leaseId') }]
      break
    case 'demand.disposition':
      // disposeDemand(demandId, {outcome, handler?, reason, duplicateOf?, parkedUntil?, leaseId?}) — the
      // duplicateOf containment is re-asserted in the facade. Demand lifecycle (Mode A).
      args = [
        p['demandId'],
        { outcome: p['outcome'], reason: p['reason'], ...opt('handler'), ...opt('duplicateOf'), ...opt('parkedUntil'), ...opt('leaseId') },
      ]
      break
    case 'spec.claim':
      // startSpec(itemId, {handler?, leaseId?, attemptId?}) — durable WHO-is-attempting fact (Mode A).
      args = [p['itemId'], { ...opt('handler'), ...opt('leaseId'), ...opt('attemptId') }]
      break
    case 'spec.abandon':
      // abandonSpec(itemId, {handler?, reason, leaseId?}) — durable explicit-abandon fact (Mode A).
      args = [p['itemId'], { reason: p['reason'], ...opt('handler'), ...opt('leaseId') }]
      break
    case 'item.restructure':
      // restructureReparent(itemId, parentId, planHash, restructureRef?) — the cross-workspace move. The
      // clientToken (f(planHash,itemId)) is threaded by the apply via withClientToken, not an arg. DESIGN R2.
      args = [p['itemId'], p['parentId'], p['planHash'], p['restructureRef']]
      break
  }

  return { kind, method, settles, payload: p, args, ...(clientToken !== undefined ? { clientToken } : {}) }
}
