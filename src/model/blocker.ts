import { DomainError, type BlockerId, type ItemId } from './item.js'
import type { ActorId } from '../events/types.js'

export type BlockerKind = 'decision' | 'dependency'
export type ResolutionRule = 'linked-done' | 'linked-accepted' | 'manual'

export interface BlockerState {
  id: BlockerId
  targetId: ItemId
  kind: BlockerKind
  ref: ItemId
  reason: string
  resolutionRule?: ResolutionRule // dependency only
  owner?: ActorId
  openedAt: string
  resolvedAt?: string
  resolvedByEvent: boolean // resolved by an explicit blocker.resolved event (manual or decision)
  open: boolean // computed by fold (SPEC §2.9)
}

export interface BlockerOpenedPayload {
  blockerId: BlockerId
  targetId: ItemId
  kind: BlockerKind
  ref: ItemId
  reason: string
  resolutionRule?: ResolutionRule
  owner?: ActorId
}

/**
 * Manual `blocker resolve` is allowed ONLY for a `manual` dependency blocker (SPEC §2.9).
 * A `decision` blocker resolves only on its Decision's outcome; a `linked-done`/`linked-accepted`
 * dependency blocker auto-resolves when its rule is met. Both reject manual resolution.
 */
export function assertManualResolve(blocker: BlockerState): void {
  if (blocker.kind === 'decision') {
    throw new DomainError(
      `cannot manually resolve a decision blocker (${blocker.id}); it resolves on the decision outcome`,
    )
  }
  if (blocker.resolutionRule !== 'manual') {
    throw new DomainError(
      `cannot manually resolve a '${blocker.resolutionRule ?? 'linked-done'}' dependency blocker (${blocker.id})`,
    )
  }
}
