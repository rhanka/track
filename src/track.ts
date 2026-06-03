import { ulid } from 'ulid'

import { EventStore } from './events/store.js'
import type { ActorId, Aggregate, CommandEvent, EventType, Ulid } from './events/types.js'
import {
  assertManualResolve,
  type BlockerKind,
  type ResolutionRule,
} from './model/blocker.js'
import {
  assertRealizationTransition,
  assertSpecTransition,
  DomainError,
  type BlockerId,
  type ItemCreatedPayload,
  type ItemId,
  type ItemState,
  type Realization,
  type SpecStatus,
} from './model/item.js'
import { fold, type State } from './state/fold.js'

export interface TrackOptions {
  /** Injectable clock (ISO-8601 ms). Defaults to wall clock. */
  now?: () => string
  /** Injectable id generator. Defaults to ULID. */
  newId?: () => Ulid
  /** Default actor recorded on events. */
  by?: ActorId
}

export interface OpenBlockerInput {
  targetId: ItemId
  kind: BlockerKind
  ref: ItemId
  reason: string
  resolutionRule?: ResolutionRule
  owner?: ActorId
}

/**
 * Command facade over the frozen event store (SPEC §6). Each mutating command folds the current
 * state, checks the transition against it (rejecting illegal ones BEFORE any append — SPEC §3),
 * then appends. Lots 3+ extend this with decisions, acceptance, priority.
 */
export class Track {
  private readonly clock: () => string
  private readonly newId: () => Ulid
  private readonly actor: ActorId

  constructor(
    private readonly store: EventStore,
    opts: TrackOptions = {},
  ) {
    this.clock = opts.now ?? (() => new Date().toISOString())
    this.newId = opts.newId ?? (() => ulid())
    this.actor = opts.by ?? 'system'
  }

  /** Materialized state from a full replay of the log. */
  state(): State {
    return fold(this.store.readAll())
  }

  createItem(input: ItemCreatedPayload): ItemId {
    if (input.kind === 'decision') {
      throw new DomainError('use createDecision for kind:"decision" (Lot 3) — it needs targets, a dossier, and an atomic blocker batch (SPEC §2.5)')
    }
    const itemId = this.newId()
    this.emit('item', itemId, 'item.created', { ...input })
    return itemId
  }

  setSpec(itemId: ItemId, to: SpecStatus): void {
    assertSpecTransition(this.requireItem(itemId), to)
    this.emit('item', itemId, 'spec.transition', { to })
  }

  /**
   * Public realization transitions: `in-progress`, `done`, `cancelled`. `rejected` is NOT
   * settable here — it is the consequence of a `no-go` Decision (SPEC §2.3, §2.6) and is emitted
   * internally by Lot 3's outcome batch (with a `cause`). `assertRealizationTransition(_, _, false)`
   * rejects a direct `→rejected` here.
   */
  setRealization(itemId: ItemId, to: Realization): void {
    assertRealizationTransition(this.requireItem(itemId), to, false)
    this.emit('item', itemId, 'realization.transition', { to })
  }

  openBlocker(input: OpenBlockerInput): BlockerId {
    const state = this.state()
    if (!state.items.has(input.targetId)) {
      throw new DomainError(`unknown target item ${input.targetId}`)
    }
    const ref = state.items.get(input.ref)
    if (!ref) {
      throw new DomainError(`unknown ref item ${input.ref}`)
    }
    if (input.kind === 'decision' && ref.kind !== 'decision') {
      throw new DomainError(`a decision blocker's ref must be a decision item (${input.ref})`)
    }
    const blockerId = this.newId()
    const resolutionRule: ResolutionRule | undefined =
      input.kind === 'dependency' ? (input.resolutionRule ?? 'linked-done') : undefined
    this.emit('blocker', blockerId, 'blocker.opened', {
      blockerId,
      targetId: input.targetId,
      kind: input.kind,
      ref: input.ref,
      reason: input.reason,
      ...(resolutionRule !== undefined ? { resolutionRule } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
    })
    return blockerId
  }

  resolveBlocker(blockerId: BlockerId): void {
    const blocker = this.state().blockers.get(blockerId)
    if (!blocker) throw new DomainError(`unknown blocker ${blockerId}`)
    assertManualResolve(blocker)
    if (!blocker.open) throw new DomainError(`blocker ${blockerId} is already resolved`)
    this.emit('blocker', blockerId, 'blocker.resolved', { blockerId })
  }

  private requireItem(itemId: ItemId): ItemState {
    const item = this.state().items.get(itemId)
    if (!item) throw new DomainError(`unknown item ${itemId}`)
    return item
  }

  private emit(
    aggregate: Aggregate,
    aggregateId: Ulid,
    type: EventType,
    payload: Record<string, unknown>,
  ): void {
    const event: CommandEvent = {
      id: this.newId(),
      type,
      aggregate,
      aggregateId,
      at: this.clock(),
      by: this.actor,
      payload,
    }
    this.store.appendCommand([event])
  }
}
