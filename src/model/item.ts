import type { Ulid } from '../events/types.js'

export type ItemId = Ulid
export type BlockerId = Ulid

export type ItemKind = 'feature' | 'bug' | 'chore' | 'decision'
export type SpecStatus = 'to-specify' | 'specified'
export type Realization = 'to-do' | 'in-progress' | 'done' | 'cancelled' | 'rejected'

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
  parentId?: ItemId
  sourceKey?: string
  body?: string
  links?: Link[]
}

export interface ItemCreatedPayload {
  kind: ItemKind
  title: string
  workspace: string
  parentId?: ItemId
  sourceKey?: string
  body?: string
  links?: Link[]
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
  item: ItemState,
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
