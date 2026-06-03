import type { TrackEvent } from '../events/types.js'
import type { BlockerOpenedPayload, BlockerState } from '../model/blocker.js'
import type {
  DecisionCreatedPayload,
  DecisionState,
  Dossier,
  Outcome,
} from '../model/decision.js'
import { isSettled } from '../model/decision.js'
import type {
  BlockerId,
  Disposition,
  Gate,
  ItemCreatedPayload,
  ItemId,
  ItemState,
  Realization,
  SpecStatus,
} from '../model/item.js'

/**
 * Materialized state (SPEC §2). The fold *mechanism* (replay in stream order, per-aggregate by
 * `seq`) is the frozen part (Lot 1); the *shape* below grows per lot — acceptance/priority are
 * layered on in Lot 4.
 *
 * Precondition: `events` is a VALIDATED stream (the store runs `validate` before every append).
 */
export interface State {
  items: Map<ItemId, ItemState> // non-decision items
  decisions: Map<ItemId, DecisionState>
  blockers: Map<BlockerId, BlockerState>
}

export function fold(events: ReadonlyArray<TrackEvent>): State {
  const items = new Map<ItemId, ItemState>()
  const decisions = new Map<ItemId, DecisionState>()
  const blockers = new Map<BlockerId, BlockerState>()

  for (const event of events) {
    applyEvent(items, decisions, blockers, event)
  }

  for (const blocker of blockers.values()) {
    blocker.open = isOpen(blocker, items)
  }

  return { items, decisions, blockers }
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
  decisions: Map<ItemId, DecisionState>,
  blockers: Map<BlockerId, BlockerState>,
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
        disposition: { orientation: 'required', commitment: 'required' },
        ...(payload.parentId !== undefined ? { parentId: payload.parentId } : {}),
        ...(payload.sourceKey !== undefined ? { sourceKey: payload.sourceKey } : {}),
        ...(payload.body !== undefined ? { body: payload.body } : {}),
        ...(payload.links !== undefined ? { links: payload.links } : {}),
      }
      items.set(item.id, item)
      break
    }

    case 'decision.created': {
      const payload = event.payload as unknown as DecisionCreatedPayload
      const decision: DecisionState = {
        id: event.aggregateId,
        kind: 'decision',
        title: payload.title,
        workspace: payload.workspace,
        realization: 'to-do',
        decisionKind: payload.decisionKind,
        targets: payload.targets,
        outcome: 'pending',
        dossier: payload.dossier,
        ...(payload.parentId !== undefined ? { parentId: payload.parentId } : {}),
        ...(payload.sourceKey !== undefined ? { sourceKey: payload.sourceKey } : {}),
        ...(payload.body !== undefined ? { body: payload.body } : {}),
        ...(payload.links !== undefined ? { links: payload.links } : {}),
      }
      decisions.set(decision.id, decision)
      break
    }

    case 'spec.transition': {
      const item = items.get(event.aggregateId)
      if (item) item.specStatus = (event.payload as { to: SpecStatus }).to
      break
    }

    case 'realization.transition': {
      const target = items.get(event.aggregateId) ?? decisions.get(event.aggregateId)
      if (target) target.realization = (event.payload as { to: Realization }).to
      break
    }

    case 'decision.outcome': {
      const decision = decisions.get(event.aggregateId)
      if (!decision) break
      const to = (event.payload as { to: Outcome }).to
      decision.outcome = to // legality is checked at append; fold takes the latest in stream order
      if (isSettled(to)) {
        // auto-complete the gate disposition on each target (SPEC §2.10; latest settle wins)
        for (const targetId of decision.targets) {
          const target = items.get(targetId)
          if (target) target.disposition[decision.decisionKind] = 'completed'
        }
      }
      break
    }

    case 'decision.disposition': {
      const payload = event.payload as { itemId: ItemId; gate: Gate; disposition: Disposition }
      const item = items.get(payload.itemId)
      if (item) item.disposition[payload.gate] = payload.disposition
      break
    }

    case 'dossier.revised': {
      const decision = decisions.get(event.aggregateId)
      if (decision) decision.dossier = (event.payload as { dossier: Dossier }).dossier
      break
    }

    case 'blocker.opened': {
      const payload = event.payload as unknown as BlockerOpenedPayload
      const resolutionRule =
        payload.resolutionRule ?? (payload.kind === 'dependency' ? 'linked-done' : undefined)
      const blocker: BlockerState = {
        id: event.aggregateId,
        targetId: payload.targetId,
        kind: payload.kind,
        ref: payload.ref,
        reason: payload.reason,
        openedAt: event.at,
        resolvedByEvent: false,
        open: true,
        ...(resolutionRule !== undefined ? { resolutionRule } : {}),
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
      // acceptance / priority events are folded in Lot 4.
      break
  }
}

function isOpen(blocker: BlockerState, items: Map<ItemId, ItemState>): boolean {
  if (blocker.resolvedByEvent) return false
  // Dependency default is linked-done (robust even if the rule was omitted upstream).
  if (blocker.kind === 'dependency' && (blocker.resolutionRule ?? 'linked-done') === 'linked-done') {
    // NOTE (open question, flagged for Lot 5): a ref that ends `cancelled`/`rejected` keeps this
    // blocker OPEN (target stays AWAITED) — SPEC §2.9 resolves only on ref `done`. Reversible.
    return items.get(blocker.ref)?.realization !== 'done'
  }
  // decision blockers, manual dependency blockers, and (until Lot 4) linked-accepted stay open
  // until an explicit blocker.resolved event (a decision blocker resolves on its go/no-go batch).
  return true
}
