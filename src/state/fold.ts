import type { TrackEvent } from '../events/types.js'
import type {
  CriterionState,
  EvidenceKind,
  EvidenceState,
  RunResult,
} from '../model/acceptance.js'
import type { BlockerOpenedPayload, BlockerState } from '../model/blocker.js'
import type {
  DecisionCreatedPayload,
  DecisionState,
  Dossier,
  DossierArtifact,
  Outcome,
} from '../model/decision.js'
import { isSettled } from '../model/decision.js'
import type { PriorityAssessment } from '../model/priority.js'
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
import type { VerificationRecordedPayload, VerificationRun } from '../model/verification.js'

/**
 * Materialized state (SPEC §2). The fold *mechanism* (replay in stream order, per-aggregate by
 * `seq`) is the frozen part (Lot 1); the *shape* below grows per lot. Acceptance *status* is a
 * pure function of this state + a baselineCommit (see `accept/`), not stored here.
 *
 * Precondition: `events` is a VALIDATED stream (the store runs `validate` before every append).
 */
export interface State {
  items: Map<ItemId, ItemState> // non-decision items
  decisions: Map<ItemId, DecisionState>
  blockers: Map<BlockerId, BlockerState>
  criteria: Map<string, CriterionState>
  evidence: Map<string, EvidenceState>
  /**
   * Scope §B(c) — path-scope verification evidence, keyed by `runId`. An EVIDENCE-ONLY collection: it
   * is read by a future `scope validate` but is INERT to bucketing/realization (a path verdict can never
   * spawn/advance/complete a TODO). Latest run per `runId` wins (stream order), like `latestRun`.
   */
  verificationRuns: Map<string, VerificationRun>
}

function emptyState(): State {
  return {
    items: new Map(),
    decisions: new Map(),
    blockers: new Map(),
    criteria: new Map(),
    evidence: new Map(),
    verificationRuns: new Map(),
  }
}

export function fold(events: ReadonlyArray<TrackEvent>): State {
  const state = emptyState()
  for (const event of events) {
    applyEvent(state, event)
  }
  for (const blocker of state.blockers.values()) {
    blocker.open = isOpen(blocker, state.items)
  }
  return state
}

/**
 * ⚠️ COMMIT-BLIND. Returns the fold scalar `blocker.open`, which is conservatively OPEN for
 * `linked-accepted` blockers (fold has no `baselineCommit`). For AWAITED / bucketing use
 * `effectiveOpenBlockersForItem(state, id, baselineCommit)` (report/blocker-status.ts), which
 * derives `linked-accepted` openness revocably against a commit. Safe here only for settle-once
 * rules (decision/manual/linked-done).
 */
export function openBlockers(state: State): BlockerState[] {
  return [...state.blockers.values()].filter((b) => b.open)
}

/** ⚠️ COMMIT-BLIND — see {@link openBlockers}; prefer `effectiveOpenBlockersForItem` for AWAITED. */
export function openBlockersForItem(state: State, itemId: ItemId): BlockerState[] {
  return openBlockers(state).filter((b) => b.targetId === itemId)
}

function applyEvent(state: State, event: TrackEvent): void {
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
        ...(payload.role !== undefined ? { role: payload.role } : {}),
        ...(payload.sourceKey !== undefined ? { sourceKey: payload.sourceKey } : {}),
        ...(payload.body !== undefined ? { body: payload.body } : {}),
        ...(payload.links !== undefined ? { links: payload.links } : {}),
        ...(payload.accountable !== undefined ? { accountable: payload.accountable } : {}),
        ...(payload.responsible !== undefined ? { responsible: payload.responsible } : {}),
        ...(payload.engagementRef !== undefined ? { engagementRef: payload.engagementRef } : {}),
      }
      state.items.set(item.id, item)
      break
    }

    case 'item.reparented': {
      // Set/clear parentId on the EXISTING item aggregate (Workpackages §2). Absent parentId ⇒ detach
      // to root. Legality (exists/same-workspace/no-self/no-cycle) is checked at append (Track.reparentItem).
      const item = state.items.get(event.aggregateId)
      if (item) {
        const parentId = (event.payload as { parentId?: ItemId }).parentId
        if (parentId !== undefined) item.parentId = parentId
        else delete item.parentId
      }
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
        ...(payload.accountable !== undefined ? { accountable: payload.accountable } : {}),
        ...(payload.engagementRef !== undefined ? { engagementRef: payload.engagementRef } : {}),
      }
      state.decisions.set(decision.id, decision)
      break
    }

    case 'spec.transition': {
      const item = state.items.get(event.aggregateId)
      if (item) item.specStatus = (event.payload as { to: SpecStatus }).to
      break
    }

    case 'realization.transition': {
      const target = state.items.get(event.aggregateId) ?? state.decisions.get(event.aggregateId)
      if (target) target.realization = (event.payload as { to: Realization }).to
      break
    }

    case 'decision.outcome': {
      const decision = state.decisions.get(event.aggregateId)
      if (!decision) break
      const to = (event.payload as { to: Outcome }).to
      decision.outcome = to // legality is checked at append; fold takes the latest in stream order
      if (isSettled(to)) {
        for (const targetId of decision.targets) {
          const target = state.items.get(targetId)
          if (target) target.disposition[decision.decisionKind] = 'completed'
        }
      }
      break
    }

    case 'decision.disposition': {
      const payload = event.payload as { itemId: ItemId; gate: Gate; disposition: Disposition }
      const item = state.items.get(payload.itemId)
      if (item) item.disposition[payload.gate] = payload.disposition
      break
    }

    case 'dossier.revised': {
      const decision = state.decisions.get(event.aggregateId)
      if (decision) decision.dossier = (event.payload as { dossier: Dossier }).dossier
      break
    }

    case 'decision.artifact-added': {
      // M5 — append ONE artifact to the decision's dossier.artifacts[] (the existing dossier is left
      // intact; no whole-dossier rewrite). Legality (union shape) is checked at append.
      const decision = state.decisions.get(event.aggregateId)
      if (decision) {
        const artifact = (event.payload as { artifact: DossierArtifact }).artifact
        decision.dossier = {
          ...decision.dossier,
          artifacts: [...(decision.dossier.artifacts ?? []), artifact],
        }
      }
      break
    }

    case 'acceptance.criterion.added': {
      const payload = event.payload as { criterionId: string; statement: string }
      state.criteria.set(payload.criterionId, {
        id: payload.criterionId,
        itemId: event.aggregateId,
        statement: payload.statement,
      })
      break
    }

    case 'acceptance.evidence.linked': {
      const payload = event.payload as {
        evidenceId: string
        criterionId: string
        kind: EvidenceKind
        locator: string
      }
      state.evidence.set(payload.evidenceId, {
        id: payload.evidenceId,
        criterionId: payload.criterionId,
        kind: payload.kind,
        locator: payload.locator,
      })
      break
    }

    case 'acceptance.run': {
      const payload = event.payload as {
        evidenceId: string
        commit: string
        env: string
        runner: string
        result: RunResult
      }
      const evidence = state.evidence.get(payload.evidenceId)
      // latest run wins (stream order)
      if (evidence) {
        evidence.latestRun = {
          evidenceId: payload.evidenceId,
          commit: payload.commit,
          env: payload.env,
          runner: payload.runner,
          result: payload.result,
          at: event.at,
        }
      }
      break
    }

    case 'scope.verification-recorded': {
      // Scope §B(c) — append path-verdict EVIDENCE keyed by runId. Touches NO realization/bucket/blocker
      // logic (structural guarantee: a path verdict can never spawn/advance/complete a TODO). The
      // offending paths are recorded VERBATIM (opaque locators); track never re-matches them.
      const payload = event.payload as unknown as VerificationRecordedPayload
      state.verificationRuns.set(payload.runId, {
        runId: payload.runId,
        runner: payload.runner,
        commit: payload.commit,
        verdict: payload.verdict,
        at: event.at,
        ...(payload.env !== undefined ? { env: payload.env } : {}),
        ...(payload.wpRef !== undefined ? { wpRef: payload.wpRef } : {}),
        ...(payload.violations !== undefined ? { violations: payload.violations } : {}),
      })
      break
    }

    case 'acceptance.waived': {
      const payload = event.payload as { criterionId: string; reason: string; by: string }
      const criterion = state.criteria.get(payload.criterionId)
      if (criterion) {
        criterion.waiver = {
          criterionId: payload.criterionId,
          reason: payload.reason,
          by: payload.by,
          at: event.at,
        }
      }
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
        reason: payload.reason,
        openedAt: event.at,
        resolvedByEvent: false,
        open: true,
        ...(payload.ref !== undefined ? { ref: payload.ref } : {}),
        ...(resolutionRule !== undefined ? { resolutionRule } : {}),
        ...(payload.owner !== undefined ? { owner: payload.owner } : {}),
        ...(payload.scope !== undefined ? { scope: payload.scope } : {}),
        ...(payload.engagementRef !== undefined ? { engagementRef: payload.engagementRef } : {}),
      }
      state.blockers.set(blocker.id, blocker)
      break
    }

    case 'blocker.resolved': {
      const blocker = state.blockers.get(event.aggregateId)
      if (blocker) {
        blocker.resolvedByEvent = true
        blocker.resolvedAt = event.at
      }
      break
    }

    case 'priority.assessed': {
      const payload = event.payload as unknown as PriorityAssessment
      const item = state.items.get(event.aggregateId)
      if (item) item.priority = payload // latest in stream order = live priority (SPEC §2.8)
      break
    }

    default:
      // `branch.imported` carries provenance only — not folded into state; read raw from the
      // event log by the v2.0 read contract (TrackReader.branchProvenance / freshness).
      break
  }
}

function isOpen(blocker: BlockerState, items: Map<ItemId, ItemState>): boolean {
  if (blocker.resolvedByEvent) return false
  // Dependency default is linked-done (robust even if the rule was omitted upstream). `ref` is always
  // present for a linked-done dep (intra); an `extra` dep is `manual` and never reaches this branch.
  if (blocker.ref !== undefined && blocker.kind === 'dependency' && (blocker.resolutionRule ?? 'linked-done') === 'linked-done') {
    // NOTE (open question, flagged for Lot 5): a ref that ends `cancelled`/`rejected` keeps this
    // blocker OPEN (target stays AWAITED) — SPEC §2.9 resolves only on ref `done`. Reversible.
    return items.get(blocker.ref)?.realization !== 'done'
  }
  // decision blockers and manual dependency blockers stay open until an explicit blocker.resolved
  // event (a decision blocker resolves on its go/no-go batch). `linked-accepted` also lands here and
  // folds CONSERVATIVELY OPEN: fold is baseline-free and cannot evaluate acceptance — its
  // authoritative, revocable openness is derived at report/query time against `baselineCommit`
  // (report/blocker-status.ts, v2.2a hybrid-A). Conservative-open is fail-safe (never falsely clear).
  return true
}
