import type { TrackEvent } from '../events/types.js'
import type {
  BlockerOpenedPayload,
  BlockerState,
} from '../model/blocker.js'
import type {
  ItemCreatedPayload,
  ItemId,
  ItemState,
  Realization,
  SpecStatus,
} from '../model/item.js'

/**
 * Materialized state (SPEC §2). The fold *mechanism* (replay in stream order, per-aggregate by
 * `seq`) is the frozen part (Lot 1); the *shape* below grows per lot — acceptance/priority are
 * layered on in Lot 4, decisions/outcome in Lot 3.
 *
 * Precondition: `events` is a VALIDATED stream (the store runs `validate` before every append).
 */
export interface State {
  items: Map<ItemId, ItemState>
  blockers: Map<string, BlockerState>
}

export function fold(events: ReadonlyArray<TrackEvent>): State {
  const items = new Map<ItemId, ItemState>()
  const blockers = new Map<string, BlockerState>()

  for (const event of events) {
    applyEvent(items, blockers, event)
  }

  // Finalize computed open-ness — depends on the final item states (e.g. linked-done).
  for (const blocker of blockers.values()) {
    blocker.open = isOpen(blocker, items)
  }

  return { items, blockers }
}

/** Open blockers across the whole backlog (SPEC §2.9; report AWAITED bucket, §7). */
export function openBlockers(state: State): BlockerState[] {
  return [...state.blockers.values()].filter((b) => b.open)
}

/** Open blockers targeting a given item. */
export function openBlockersForItem(state: State, itemId: ItemId): BlockerState[] {
  return openBlockers(state).filter((b) => b.targetId === itemId)
}

function applyEvent(
  items: Map<ItemId, ItemState>,
  blockers: Map<string, BlockerState>,
  event: TrackEvent,
): void {
  switch (event.type) {
    case 'item.created': {
      const payload = event.payload as unknown as ItemCreatedPayload
      const item: ItemState = {
        id: event.aggregateId,
        kind: payload.kind,
        title: payload.title,
        workspace: payload.workspace,
        specStatus: payload.kind === 'decision' ? 'n/a' : 'to-specify',
        realization: 'to-do',
        ...(payload.parentId !== undefined ? { parentId: payload.parentId } : {}),
        ...(payload.sourceKey !== undefined ? { sourceKey: payload.sourceKey } : {}),
        ...(payload.body !== undefined ? { body: payload.body } : {}),
        ...(payload.links !== undefined ? { links: payload.links } : {}),
      }
      items.set(item.id, item)
      break
    }

    case 'spec.transition': {
      const item = items.get(event.aggregateId)
      if (item) item.specStatus = (event.payload as { to: SpecStatus }).to
      break
    }

    case 'realization.transition': {
      const item = items.get(event.aggregateId)
      if (item) item.realization = (event.payload as { to: Realization }).to
      break
    }

    case 'blocker.opened': {
      const payload = event.payload as unknown as BlockerOpenedPayload
      const blocker: BlockerState = {
        id: event.aggregateId,
        targetId: payload.targetId,
        kind: payload.kind,
        ref: payload.ref,
        reason: payload.reason,
        openedAt: event.at,
        resolvedByEvent: false,
        open: true,
        ...(payload.resolutionRule !== undefined ? { resolutionRule: payload.resolutionRule } : {}),
        ...(payload.owner !== undefined ? { owner: payload.owner } : {}),
      }
      blockers.set(blocker.id, blocker)
      break
    }

    case 'blocker.resolved': {
      const blocker = blockers.get(event.aggregateId)
      if (blocker) {
        blocker.resolvedByEvent = true
        blocker.resolvedAt = event.at
      }
      break
    }

    default:
      // decision / acceptance / priority events are folded in later lots.
      break
  }
}

function isOpen(blocker: BlockerState, items: Map<ItemId, ItemState>): boolean {
  if (blocker.resolvedByEvent) return false
  if (blocker.kind === 'dependency' && blocker.resolutionRule === 'linked-done') {
    return items.get(blocker.ref)?.realization !== 'done'
  }
  // decision blockers, manual dependency blockers, and (until Lot 4) linked-accepted stay open
  // until an explicit blocker.resolved event.
  return true
}
