import { ulid } from 'ulid'

import { EventStore } from './events/store.js'
import type { ActorId, Aggregate, CommandEvent, EventType, Ulid } from './events/types.js'
import { parseRunReport, type RunReportFormat } from './accept/ingest.js'
import {
  buildReport,
  query as runQuery,
  type QueryFilter,
  type Report,
  type ReportOptions,
  type ReportRow,
} from './report/build.js'
import type { EvidenceKind, RunResult } from './model/acceptance.js'
import {
  WSJF_SCHEME_VERSION,
  wsjfScore,
  type PriorityAssessment,
  type WsjfInputs,
} from './model/priority.js'
import {
  assertManualResolve,
  type BlockerKind,
  type ResolutionRule,
} from './model/blocker.js'
import {
  assertOutcomeTransition,
  type DecisionCreatedPayload,
  type Dossier,
  type Outcome,
} from './model/decision.js'
import {
  assertRealizationTransition,
  assertSpecTransition,
  DomainError,
  type BlockerId,
  type Disposition,
  type Gate,
  type ItemCreatedPayload,
  type ItemId,
  type ItemState,
  type Realization,
  type SpecStatus,
} from './model/item.js'
import { fold, type State } from './state/fold.js'

interface EventPart {
  aggregate: Aggregate
  aggregateId: Ulid
  type: EventType
  payload: Record<string, unknown>
}

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
    const state = this.state()
    const item = state.items.get(itemId)
    if (item) {
      assertRealizationTransition(item, to, false)
      this.emit('item', itemId, 'realization.transition', { to })
      return
    }
    const decision = state.decisions.get(itemId)
    if (decision) {
      assertRealizationTransition(decision, to, false)
      this.emit('decision', itemId, 'realization.transition', { to })
      return
    }
    throw new DomainError(`unknown item ${itemId}`)
  }

  /**
   * Create a Decision (SPEC §2.5): emits `decision.created` + one `blocker.opened` (kind:decision)
   * per target as ONE atomic batch (A7). Targets must be existing non-decision items (A3 recursion
   * guard). The decision starts `outcome:"pending"`, leaving every target AWAITED until it settles.
   */
  createDecision(input: DecisionCreatedPayload): ItemId {
    if (input.targets.length === 0) {
      throw new DomainError('a decision needs at least one target (SPEC §2.5)')
    }
    if (new Set(input.targets).size !== input.targets.length) {
      throw new DomainError('a decision cannot list the same target twice')
    }
    const state = this.state()
    for (const targetId of input.targets) {
      if (state.decisions.has(targetId)) {
        throw new DomainError(`a decision cannot target another decision (${targetId}) [A3]`)
      }
      if (!state.items.has(targetId)) {
        throw new DomainError(`unknown target item ${targetId}`)
      }
    }
    const decisionId = this.newId()
    const parts: EventPart[] = [
      { aggregate: 'decision', aggregateId: decisionId, type: 'decision.created', payload: { ...input } },
    ]
    for (const targetId of input.targets) {
      const blockerId = this.newId()
      parts.push({
        aggregate: 'blocker',
        aggregateId: blockerId,
        type: 'blocker.opened',
        payload: {
          blockerId,
          targetId,
          kind: 'decision',
          ref: decisionId,
          reason: `awaiting ${input.decisionKind} decision`,
        },
      })
    }
    this.emitBatch(parts)
    return decisionId
  }

  /**
   * Settle (or defer) a Decision's outcome (SPEC §2.6). Legal: pending→{go,no-go,deferred};
   * deferred→{go,no-go}; go/no-go terminal. Emits the effect as ONE atomic batch (A5):
   * `go` resolves each target's decision blocker; `no-go` also rejects each non-terminal target
   * (cause:{decisionId}); `deferred` emits only the outcome (target stays AWAITED).
   */
  setOutcome(decisionId: ItemId, to: Outcome): void {
    const state = this.state()
    const decision = state.decisions.get(decisionId)
    if (!decision) throw new DomainError(`unknown decision ${decisionId}`)
    assertOutcomeTransition(decision.outcome, to)

    const parts: EventPart[] = [
      { aggregate: 'decision', aggregateId: decisionId, type: 'decision.outcome', payload: { to } },
    ]
    if (to === 'go' || to === 'no-go') {
      for (const targetId of decision.targets) {
        const blocker = [...state.blockers.values()].find(
          (b) => b.kind === 'decision' && b.ref === decisionId && b.targetId === targetId && b.open,
        )
        if (blocker) {
          parts.push({
            aggregate: 'blocker',
            aggregateId: blocker.id,
            type: 'blocker.resolved',
            payload: { blockerId: blocker.id, decisionId },
          })
        }
        if (to === 'no-go') {
          const target = state.items.get(targetId)
          // Reject only NON-terminal targets. A target already done/cancelled/rejected keeps its
          // realization (we do not retro-reject finished work); its decision blocker is still
          // resolved above. Rejecting the whole no-go when a target is terminal would make a
          // decision with an independently-finished (done) target UN-SETTLEABLE forever — strictly
          // worse. (Reviewer split here; the done-under-no-go semantics are flagged for the user.)
          if (target && (target.realization === 'to-do' || target.realization === 'in-progress')) {
            parts.push({
              aggregate: 'item',
              aggregateId: targetId,
              type: 'realization.transition',
              payload: { to: 'rejected', cause: { decisionId } },
            })
          }
        }
      }
    }
    this.emitBatch(parts)
  }

  reviseDossier(decisionId: ItemId, dossier: Dossier): void {
    if (!this.state().decisions.has(decisionId)) {
      throw new DomainError(`unknown decision ${decisionId}`)
    }
    this.emit('decision', decisionId, 'dossier.revised', { dossier })
  }

  /**
   * Set a gate disposition explicitly (SPEC §2.10). `completed` is NOT settable here — it is set
   * automatically when a Decision of that gate targeting the item settles.
   */
  setDisposition(itemId: ItemId, gate: Gate, disposition: Disposition, reason?: string): void {
    if (disposition === 'completed') {
      throw new DomainError(
        'disposition "completed" is set automatically when a decision settles (SPEC §2.10)',
      )
    }
    if (!this.state().items.has(itemId)) throw new DomainError(`unknown item ${itemId}`)
    this.emit('item', itemId, 'decision.disposition', {
      itemId,
      gate,
      disposition,
      ...(reason !== undefined ? { reason } : {}),
    })
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

  // ---- Acceptance (SPEC §2.4) ----

  /** Add an acceptance criterion to a non-decision item (A3 forbids criteria on a Decision). */
  addCriterion(itemId: ItemId, statement: string): string {
    const state = this.state()
    if (state.decisions.has(itemId)) {
      throw new DomainError(`cannot add an acceptance criterion to a decision (${itemId}) [A3]`)
    }
    if (!state.items.has(itemId)) throw new DomainError(`unknown item ${itemId}`)
    const criterionId = this.newId()
    this.emit('item', itemId, 'acceptance.criterion.added', { criterionId, statement })
    return criterionId
  }

  linkEvidence(criterionId: string, kind: EvidenceKind, locator: string): string {
    const criterion = this.state().criteria.get(criterionId)
    if (!criterion) throw new DomainError(`unknown criterion ${criterionId}`)
    const evidenceId = this.newId()
    this.emit('item', criterion.itemId, 'acceptance.evidence.linked', {
      evidenceId,
      criterionId,
      kind,
      locator,
    })
    return evidenceId
  }

  recordRun(
    evidenceId: string,
    run: { commit: string; env: string; runner: string; result: RunResult },
  ): void {
    this.emit('item', this.evidenceOwner(evidenceId), 'acceptance.run', { evidenceId, ...run })
  }

  waive(criterionId: string, reason: string): void {
    const criterion = this.state().criteria.get(criterionId)
    if (!criterion) throw new DomainError(`unknown criterion ${criterionId}`)
    this.emit('item', criterion.itemId, 'acceptance.waived', {
      criterionId,
      reason,
      by: this.actor,
    })
  }

  /**
   * Ingest a test report (`accept run --from`): match each entry to an evidence by `locator` and
   * emit one `acceptance.run` per match as a single atomic batch. Returns the number of runs.
   */
  ingestRuns(
    content: string,
    format: RunReportFormat,
    run: { commit: string; env: string; runner: string },
  ): number {
    const state = this.state()
    const parts: EventPart[] = []
    for (const entry of parseRunReport(content, format)) {
      // A locator may be shared by several evidence — record the run for ALL of them.
      for (const evidence of state.evidence.values()) {
        if (evidence.locator !== entry.locator) continue
        const criterion = state.criteria.get(evidence.criterionId)
        if (!criterion) continue
        parts.push({
          aggregate: 'item',
          aggregateId: criterion.itemId,
          type: 'acceptance.run',
          payload: {
            evidenceId: evidence.id,
            commit: run.commit,
            env: run.env,
            runner: run.runner,
            result: entry.result,
          },
        })
      }
    }
    if (parts.length === 0) return 0
    this.emitBatch(parts)
    return parts.length
  }

  // ---- Prioritization (SPEC §2.8) ----

  /** Append a WSJF priority assessment; the latest becomes the item's live `priority`. */
  assessPriority(itemId: ItemId, inputs: WsjfInputs): PriorityAssessment {
    if (!this.state().items.has(itemId)) throw new DomainError(`unknown item ${itemId}`)
    const assessment: PriorityAssessment = {
      itemId,
      schemeId: 'wsjf',
      schemeVersion: WSJF_SCHEME_VERSION,
      inputs: { ...inputs },
      score: wsjfScore(inputs),
      at: this.clock(),
    }
    this.emit('item', itemId, 'priority.assessed', { ...assessment })
    return assessment
  }

  // ---- Reporting (read-only, SPEC §6/§7) ----

  /** Bucketed backlog report over non-decision items (SPEC §7). */
  report(options: ReportOptions): Report {
    return buildReport(this.state(), options)
  }

  /** Flat, filtered query over the report rows (SPEC §6). */
  query(filter: QueryFilter, options: ReportOptions): ReportRow[] {
    return runQuery(this.state(), filter, options)
  }

  private evidenceOwner(evidenceId: string): ItemId {
    const state = this.state()
    const evidence = state.evidence.get(evidenceId)
    if (!evidence) throw new DomainError(`unknown evidence ${evidenceId}`)
    const criterion = state.criteria.get(evidence.criterionId)
    if (!criterion) throw new DomainError(`evidence ${evidenceId} references an unknown criterion`)
    return criterion.itemId
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
    this.emitBatch([{ aggregate, aggregateId, type, payload }])
  }

  /** Append a command's events; a multi-event command is one atomic `cmdId` batch (SPEC §3). */
  private emitBatch(parts: EventPart[]): void {
    const at = this.clock()
    const events: CommandEvent[] = parts.map((part) => ({
      id: this.newId(),
      type: part.type,
      aggregate: part.aggregate,
      aggregateId: part.aggregateId,
      at,
      by: this.actor,
      payload: part.payload,
    }))
    if (events.length > 1) {
      this.store.appendCommand(events, { cmdId: this.newId() })
    } else {
      this.store.appendCommand(events)
    }
  }
}
