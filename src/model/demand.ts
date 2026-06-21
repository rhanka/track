// Demand lifecycle (Mode A) — the `demand` aggregate model (DESIGN demand-lifecycle-modeA §D1).
//
// A `demand` is a new first-class aggregate that tracks work from `raised` (issue) through `agreed`,
// where it PROMOTES into one or more `item`s. The backlog stays honest (only agreed work is an item);
// rejected/duplicate/parked demands never pollute item reads. Mirrors the `decision`-aggregate pattern.
//
// ADDITIVE to the FROZEN event contract: every new payload field is drop-when-absent (canonicalize drops
// undefined), so old logs replay byte-identical. The lifecycle machine here mirrors OUTCOME_TRANSITIONS /
// REALIZATION_TRANSITIONS — legality is checked AT APPEND in the facade; the fold stays pure.

import { DomainError, type ItemId, type Link } from './item.js'
import type { ActorId, Ulid } from '../events/types.js'

export type DemandId = Ulid
export type DemandType = 'feature' | 'defect' | 'chore' // additive; extensible
export type DemandStatus = 'raised' | 'qualifying' | 'agreed' | 'rejected' | 'duplicate' | 'parked'

/** The t=0 capture of a demand — immutable raw input (DESIGN §D1). */
export interface DemandRaw {
  text: string
  title?: string
  format?: 'plain' | 'markdown'
}

/** WHO/WHAT raised the demand — recorded immutably on `demand.raised` (DESIGN §D1). */
export interface DemandSource {
  kind: 'human' | 'agent' | 'h2a' | 'import' | 'external'
  actor?: ActorId
  ref?: string
  locator?: string
}

/** A back-reference to a survivor (a `duplicate` demand points at the demand/item it duplicates). */
export interface DemandRef {
  kind: 'demand' | 'item'
  id: string
}

export interface DemandState {
  id: DemandId
  workspace: string
  type: DemandType
  raw: DemandRaw // t=0 capture, immutable
  source: DemandSource
  status: DemandStatus
  itemIds?: ItemId[] // set at agreed (1..N promoted items)
  duplicateOf?: DemandRef
  rejectReason?: string
  parkReason?: string
  concerns?: { kind: 'item'; id: ItemId } // a defect links the delivered item it regresses
  sourceKey?: string // optional stable dedup key (e.g. issue id)
  links?: Link[]
}

// Lifecycle machine (DESIGN state machine §):
//   none ─► raised ─► qualifying ─► agreed (terminal on the demand axis = the PIVOT)
//                          ├─► rejected   (terminal)
//                          ├─► duplicate  (terminal → survivor)
//                          └─► parked ─► qualifying   (re-entrant)
// `raised → qualifying` is mandatory before any off-ramp (every outcome is attributable to a handler).
export const DEMAND_TRANSITIONS: Record<DemandStatus, ReadonlyArray<DemandStatus>> = {
  raised: ['qualifying'],
  qualifying: ['agreed', 'rejected', 'duplicate', 'parked'],
  agreed: [],
  rejected: [],
  duplicate: [],
  parked: ['qualifying'],
}

export function assertDemandTransition(current: DemandStatus, to: DemandStatus): void {
  if (!DEMAND_TRANSITIONS[current].includes(to)) {
    throw new DomainError(`illegal demand transition ${current} -> ${to}`)
  }
}

/** A demand status from which no further lifecycle transition is legal (agreed/rejected/duplicate). */
export function isDemandTerminal(status: DemandStatus): boolean {
  return DEMAND_TRANSITIONS[status].length === 0
}

/** The off-ramp outcomes a `demand.disposition` may record (a subset of DemandStatus). */
export type DispositionOutcome = 'rejected' | 'duplicate' | 'parked'
const DISPOSITION_OUTCOMES: ReadonlyArray<DispositionOutcome> = ['rejected', 'duplicate', 'parked']

/** Fail-closed: a disposition outcome must be rejected|duplicate|parked (NOT agreed — agree is its own command). */
export function assertDispositionOutcome(outcome: unknown): DispositionOutcome {
  if (typeof outcome !== 'string' || !DISPOSITION_OUTCOMES.includes(outcome as DispositionOutcome)) {
    throw new DomainError(
      `demand.disposition: outcome must be one of ${DISPOSITION_OUTCOMES.join('|')} (got "${String(outcome)}")`,
    )
  }
  return outcome as DispositionOutcome
}

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const DEMAND_TYPES: ReadonlyArray<DemandType> = ['feature', 'defect', 'chore']
const SOURCE_KINDS: ReadonlyArray<DemandSource['kind']> = ['human', 'agent', 'h2a', 'import', 'external']

/** The `demand.raise` → `demand.raised` payload — the immutable t=0 capture + the handler. */
export interface DemandRaisedPayload {
  type: DemandType
  raw: DemandRaw
  source: DemandSource
  handler: ActorId
  sourceKey?: string
  concerns?: { kind: 'item'; id: ItemId }
  links?: Link[]
}

function assertRaw(input: unknown): DemandRaw {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DomainError('demand.raise: raw must be an object')
  }
  const r = input as Record<string, unknown>
  if (!nonEmptyString(r['text'])) throw new DomainError('demand.raise: raw.text is required (the t=0 capture)')
  if (r['title'] !== undefined && typeof r['title'] !== 'string') {
    throw new DomainError('demand.raise: raw.title must be a string')
  }
  if (r['format'] !== undefined && r['format'] !== 'plain' && r['format'] !== 'markdown') {
    throw new DomainError('demand.raise: raw.format must be "plain" or "markdown"')
  }
  return {
    text: r['text'],
    ...(r['title'] !== undefined ? { title: r['title'] as string } : {}),
    ...(r['format'] !== undefined ? { format: r['format'] as 'plain' | 'markdown' } : {}),
  }
}

function assertSource(input: unknown): DemandSource {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DomainError('demand.raise: source must be an object')
  }
  const s = input as Record<string, unknown>
  if (!SOURCE_KINDS.includes(s['kind'] as DemandSource['kind'])) {
    throw new DomainError(`demand.raise: source.kind must be one of ${SOURCE_KINDS.join('|')} (got "${String(s['kind'])}")`)
  }
  for (const key of ['actor', 'ref', 'locator'] as const) {
    if (s[key] !== undefined && typeof s[key] !== 'string') {
      throw new DomainError(`demand.raise: source.${key} must be a string`)
    }
  }
  return {
    kind: s['kind'] as DemandSource['kind'],
    ...(s['actor'] !== undefined ? { actor: s['actor'] as ActorId } : {}),
    ...(s['ref'] !== undefined ? { ref: s['ref'] as string } : {}),
    ...(s['locator'] !== undefined ? { locator: s['locator'] as string } : {}),
  }
}

function assertConcerns(input: unknown): { kind: 'item'; id: ItemId } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DomainError('demand.raise: concerns must be an object')
  }
  const c = input as Record<string, unknown>
  if (c['kind'] !== 'item') throw new DomainError('demand.raise: concerns.kind must be "item"')
  if (!nonEmptyString(c['id'])) throw new DomainError('demand.raise: concerns.id is required')
  return { kind: 'item', id: c['id'] }
}

/**
 * Fail-closed validation + normalization of a `DemandRaisedPayload` (mirrors `assertDossierArtifact` /
 * `assertSpecAmend`). Requires `type`/`raw.text`/`source.kind`/`handler`; drops absent optionals so the
 * recorded shape is minimal + hash-stable (canonicalize drops undefined ⇒ the additive invariant). The
 * `handler` (who is handling — the h2a instance id) is MANDATORY: every lifecycle step names its handler.
 */
export function assertDemandRaised(input: unknown): DemandRaisedPayload {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DomainError('demand.raise: a demand must be an object')
  }
  const a = input as Record<string, unknown>
  if (!DEMAND_TYPES.includes(a['type'] as DemandType)) {
    throw new DomainError(`demand.raise: type must be one of ${DEMAND_TYPES.join('|')} (got "${String(a['type'])}")`)
  }
  if (!nonEmptyString(a['handler'])) {
    throw new DomainError('demand.raise: a handler is required (who is handling must be logged on every step)')
  }
  const raw = assertRaw(a['raw'])
  const source = assertSource(a['source'])
  if (a['sourceKey'] !== undefined && typeof a['sourceKey'] !== 'string') {
    throw new DomainError('demand.raise: sourceKey must be a string')
  }
  const concerns = a['concerns'] !== undefined ? assertConcerns(a['concerns']) : undefined
  if (a['links'] !== undefined && !Array.isArray(a['links'])) {
    throw new DomainError('demand.raise: links must be an array')
  }
  return {
    type: a['type'] as DemandType,
    raw,
    source,
    handler: a['handler'],
    ...(a['sourceKey'] !== undefined ? { sourceKey: a['sourceKey'] as string } : {}),
    ...(concerns !== undefined ? { concerns } : {}),
    ...(a['links'] !== undefined ? { links: a['links'] as Link[] } : {}),
  }
}
