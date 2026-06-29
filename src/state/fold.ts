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
  ScopeDecl,
  SpecStatus,
} from '../model/item.js'
import type { VerificationRecordedPayload, VerificationRun } from '../model/verification.js'
import type { SpecAmendment, SpecAmendPayload } from '../model/spec-amend.js'
import type {
  DemandId,
  DemandRaisedPayload,
  DemandState,
  DispositionOutcome,
  DemandRef,
} from '../model/demand.js'

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
  /**
   * M5 (canevas) — per-item LIVE spec amendments, in stream order (keyed by itemId). RECORD-ONLY: each
   * `spec.amended` event appends here and mutates NO spec field destructively — the amendment trace IS the
   * value. INERT to bucketing/realization (a spec amendment can never spawn/advance/complete a TODO). The
   * full prov-tagged human/machine trace is reconstructed by `TrackReader.amendmentTrace` over the raw log.
   */
  specAmendments: Map<ItemId, SpecAmendment[]>
  /**
   * Demand lifecycle (Mode A) — the `demand` aggregate's materialized state, keyed by DemandId. PURE
   * last-writer-wins in stream order: legality (the lifecycle machine + duplicateOf containment) is checked
   * AT APPEND in the facade, NEVER in the fold (the established pattern — cf. decision.outcome). The
   * spec-attempt facts (`spec.started`/`spec.abandoned`) are NOT folded into a state field in Build 1; they
   * are durable handler-log facts read raw from the log (the lease side-store + reads come in Build 2).
   */
  demands: Map<DemandId, DemandState>
}

function emptyState(): State {
  return {
    items: new Map(),
    decisions: new Map(),
    blockers: new Map(),
    criteria: new Map(),
    evidence: new Map(),
    verificationRuns: new Map(),
    specAmendments: new Map(),
    demands: new Map(),
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
        ...(payload.scope !== undefined ? { scope: payload.scope } : {}),
        ...(payload.sourceKey !== undefined ? { sourceKey: payload.sourceKey } : {}),
        ...(payload.body !== undefined ? { body: payload.body } : {}),
        ...(payload.links !== undefined ? { links: payload.links } : {}),
        ...(payload.accountable !== undefined ? { accountable: payload.accountable } : {}),
        ...(payload.responsible !== undefined ? { responsible: payload.responsible } : {}),
        ...(payload.engagementRef !== undefined ? { engagementRef: payload.engagementRef } : {}),
        // Demand lifecycle (Mode A, additive) — the parent demand back-link, set ONLY by the atomic
        // agreeDemand promotion batch; absent on a directly-created item (drop-when-absent).
        ...(payload.demandId !== undefined ? { demandId: payload.demandId } : {}),
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

    case 'scope.declared': {
      // Scope §B(a) — set/replace the declarative scope on the EXISTING WP/spec-phase aggregate (latest
      // wins in stream order). Role legality is checked at append (Track.declareScope). INERT: track
      // stores the path globs, NEVER matches them; touches no realization/bucket logic.
      const item = state.items.get(event.aggregateId)
      if (item) item.scope = (event.payload as { scope: ScopeDecl }).scope
      break
    }

    case 'item.code-assigned': {
      // WP-codes (DESIGN wp-codes A1) — set/replace the DURABLE display `code` on the EXISTING role-
      // container aggregate (LWW in stream order). Legality (item exists, is a role-container, code
      // non-empty, roster-global uniqueness) is checked at append (Track.assignCode) AND re-asserted under
      // the lock (F2) — NEVER in the fold (the established pattern). DISPLAY-ONLY: touches no realization/
      // bucket/ref logic. An old reader without this case hits `default` and ignores the event (fail-safe).
      const item = state.items.get(event.aggregateId)
      if (item) item.code = (event.payload as { code: string }).code
      break
    }

    case 'spec.amended': {
      // M5 (canevas) — append ONE record-only spec amendment to the item's specAmendments[] (in stream
      // order). RECORD-ONLY: mutates NO spec field (specStatus untouched) — the amendment trace IS the
      // value. The JsonPatch + baseHash/resultHash are recorded VERBATIM; track never applies/recomputes.
      const payload = event.payload as unknown as SpecAmendPayload
      const amendment: SpecAmendment = {
        itemId: payload.itemId,
        baseHash: payload.baseHash,
        patch: payload.patch,
        resultHash: payload.resultHash,
        at: event.at,
        ...(payload.decisionId !== undefined ? { decisionId: payload.decisionId } : {}),
        ...(payload.liveDocRef !== undefined ? { liveDocRef: payload.liveDocRef } : {}),
        ...(payload.proposalRef !== undefined ? { proposalRef: payload.proposalRef } : {}),
        ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
      }
      const list = state.specAmendments.get(payload.itemId) ?? []
      list.push(amendment)
      state.specAmendments.set(payload.itemId, list)
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

    case 'realization.anchored': {
      // Acceptance-freshness lifecycle — set/replace the item's realization ANCHOR commit (LAST-write-wins
      // in stream order; priors stay in the log for audit). The `reason` (`realize`|`consolidate`) is audit
      // metadata only — both re-point the same `realizedCommit`. A READ DETAIL: touches NO realization/
      // acceptance/bucket logic (AcceptanceStatus stays strict-against-baselineCommit). Restricted to a real
      // item at append (Track.anchorRealization), so this is a no-op for an unknown/decision aggregate.
      const item = state.items.get(event.aggregateId)
      if (item) item.realizedCommit = (event.payload as { commit: string }).commit
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
        // IN-MEMORY DERIVED STATE ONLY (NOT a persisted payload field) — carries the originating delivery's
        // clientToken so linkEvidence's collision guard can distinguish "my own concurrent retry" (same token
        // ⇒ let the under-lock dedup return the original) from "a different command re-using the id" (collision
        // ⇒ throw). Zero contentHash/contract impact: no event payload/schema/computeHash change.
        ...(event.clientToken !== undefined ? { originClientToken: event.clientToken } : {}),
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
        // Seam v0 (S2) — carry the opaque artifactLocator VERBATIM, drop-when-absent so a pre-freeze event
        // (no locator) folds to a byte-identical VerificationRun (the additive-hash invariant).
        ...(payload.artifactLocator !== undefined ? { artifactLocator: payload.artifactLocator } : {}),
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

    case 'demand.raised': {
      // Demand lifecycle (Mode A) — materialize a new demand in status `raised`. The t=0 `raw`/`source` are
      // the immutable capture; `handler` is a payload field (NOT folded into demand state in Build 1 — the
      // per-step handler log is read raw from the events). Legality (none→raised) is implicit (a fresh id).
      const payload = event.payload as unknown as DemandRaisedPayload & { workspace: string }
      const demand: DemandState = {
        id: event.aggregateId,
        workspace: payload.workspace,
        type: payload.type,
        raw: payload.raw,
        source: payload.source,
        status: 'raised',
        ...(payload.sourceKey !== undefined ? { sourceKey: payload.sourceKey } : {}),
        ...(payload.concerns !== undefined ? { concerns: payload.concerns } : {}),
        ...(payload.links !== undefined ? { links: payload.links } : {}),
      }
      state.demands.set(demand.id, demand)
      break
    }

    case 'demand.qualifying-started': {
      // raised|parked → qualifying (claim). PURE last-writer-wins; legality checked at append.
      const demand = state.demands.get(event.aggregateId)
      if (demand) demand.status = 'qualifying'
      break
    }

    case 'demand.agreed': {
      // The PIVOT — the demand is agreed and PROMOTED to its item(s) (the item.created siblings land in the
      // SAME atomic batch). Record the agreed status + the promoted itemIds back-link. Legality (qualifying→
      // agreed) checked at append.
      const demand = state.demands.get(event.aggregateId)
      if (demand) {
        demand.status = 'agreed'
        const itemIds = (event.payload as { itemIds?: ItemId[] }).itemIds
        if (itemIds !== undefined) demand.itemIds = itemIds
      }
      break
    }

    case 'demand.disposition': {
      // qualifying → rejected|duplicate|parked (the recorded qualification off-ramp). PURE last-writer-wins;
      // legality (transition + duplicateOf containment) is checked at append. Records the outcome status +
      // the reason on the matching field (rejectReason/parkReason) + the duplicateOf survivor.
      const demand = state.demands.get(event.aggregateId)
      if (demand) {
        const payload = event.payload as {
          outcome: DispositionOutcome
          reason?: string
          duplicateOf?: DemandRef
        }
        demand.status = payload.outcome
        if (payload.outcome === 'rejected' && payload.reason !== undefined) demand.rejectReason = payload.reason
        if (payload.outcome === 'parked' && payload.reason !== undefined) demand.parkReason = payload.reason
        if (payload.outcome === 'duplicate' && payload.duplicateOf !== undefined) demand.duplicateOf = payload.duplicateOf
      }
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
