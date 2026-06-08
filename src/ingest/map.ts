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
      args = [p['criterionId'], p['kind'], p['locator']]
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
  }

  return { kind, method, settles, payload: p, args, ...(clientToken !== undefined ? { clientToken } : {}) }
}
