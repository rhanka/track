import type { ActorId, Ulid } from '../events/types.js'
import type { PriorityAssessment } from './priority.js'

export type ItemId = Ulid
export type BlockerId = Ulid

export type ItemKind = 'feature' | 'bug' | 'chore' | 'decision'
/**
 * An optional, additive container marker (Workpackages design §2). A workpackage is `kind:'chore'`
 * + `role:'workpackage'` — WP-ness comes ONLY from this field, never inferred from kind, children, a
 * `wp:` sourceKey, or a link. Orthogonal/optional like `accountable`/`engagementRef` ⇒ zero hash
 * change, explicit, queryable, rename-stable. (A durable public `code?` label is deferred.)
 */
export type ItemRole = 'workpackage'
export type SpecStatus = 'to-specify' | 'specified'
export type Realization = 'to-do' | 'in-progress' | 'done' | 'cancelled' | 'rejected'

// Decision gates an Item passes (SPEC §2.10). `Gate` doubles as a Decision's `decisionKind`.
export type Gate = 'orientation' | 'commitment'
export type Disposition = 'required' | 'skipped' | 'not-applicable' | 'completed'

export interface Link {
  kind: string
  locator: string
}

/** A realization → `rejected` is the consequence of a `no-go` Decision (SPEC §2.3, §2.6). */
export interface RealizationCause {
  decisionId: ItemId
}

export interface ItemState {
  id: ItemId
  kind: ItemKind
  title: string
  workspace: string
  specStatus: SpecStatus | 'n/a' // `n/a` for kind:"decision" (SPEC §2.2)
  realization: Realization
  disposition: Record<Gate, Disposition> // per-gate disposition (SPEC §2.10)
  priority?: PriorityAssessment // latest assessment, live sort key (SPEC §2.8)
  parentId?: ItemId
  role?: ItemRole // additive container marker (Workpackages §2); present ⇒ a workpackage
  sourceKey?: string
  body?: string
  links?: Link[]
  // RACI (Lot A, additive): WHO is answerable/doing — domain data about the work, distinct from
  // the event writer `by` (which the ingest seam pins to the channel). `engagementRef` links to an
  // h2a ENGAGEMENT (the executable contract); present ⇒ a contract exists. track records, never owns it.
  accountable?: ActorId // RACI-A — the single neck-to-grab
  responsible?: ActorId[] // RACI-R — the doers
  engagementRef?: string
}

export interface ItemCreatedPayload {
  kind: ItemKind
  title: string
  workspace: string
  parentId?: ItemId
  role?: ItemRole
  sourceKey?: string
  body?: string
  links?: Link[]
  accountable?: ActorId
  responsible?: ActorId[]
  engagementRef?: string
}

/** A rejected domain command (illegal transition, unknown aggregate, …). */
export class DomainError extends Error {
  override name = 'DomainError'
}

// Spec axis is monotone: `to-specify → specified` once; reverse rejected (SPEC §2.2).
const SPEC_TRANSITIONS: Record<SpecStatus, ReadonlyArray<SpecStatus>> = {
  'to-specify': ['specified'],
  specified: [],
}

// Realization forward transitions (SPEC §2.3). `rejected` is handled separately — it is only
// reachable from a `no-go` Decision (with a cause), never a manual transition.
const REALIZATION_TRANSITIONS: Record<Realization, ReadonlyArray<Realization>> = {
  'to-do': ['in-progress', 'cancelled'],
  'in-progress': ['done', 'cancelled'],
  done: [],
  cancelled: [],
  rejected: [],
}

export function assertSpecTransition(item: ItemState, to: SpecStatus): void {
  if (item.specStatus === 'n/a') {
    throw new DomainError(`spec axis is n/a for ${item.kind} item ${item.id}`)
  }
  if (!SPEC_TRANSITIONS[item.specStatus].includes(to)) {
    throw new DomainError(`illegal spec transition ${item.specStatus} -> ${to} (item ${item.id})`)
  }
}

export function assertRealizationTransition(
  item: { id: ItemId; realization: Realization }, // ItemState or DecisionState — both have realization
  to: Realization,
  hasCause: boolean,
): void {
  if (to === 'rejected') {
    if (!hasCause) {
      throw new DomainError(`realization -> rejected requires a decision cause (item ${item.id})`)
    }
    if (item.realization !== 'to-do' && item.realization !== 'in-progress') {
      throw new DomainError(
        `illegal realization transition ${item.realization} -> rejected (item ${item.id})`,
      )
    }
    return
  }
  if (!REALIZATION_TRANSITIONS[item.realization].includes(to)) {
    throw new DomainError(
      `illegal realization transition ${item.realization} -> ${to} (item ${item.id})`,
    )
  }
}
