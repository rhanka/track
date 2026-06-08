import { ulid } from 'ulid'

import { EventStore } from './events/store.js'
import type { ActorId, Aggregate, CommandEvent, EventType, Provenance, Ulid } from './events/types.js'
import { parseRunReport, type RunReportFormat } from './accept/ingest.js'
import { parseBranch, slugify } from './branch/parse.js'
import { branchSignature } from './branch/signature.js'
import { computeHash } from './events/canonical.js'
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
  type Link,
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

export interface ImportResult {
  branchSlug: string
  featureId: ItemId
  created: number
  updated: number
}

export interface TrackOptions {
  /** Injectable clock (ISO-8601 ms). Defaults to wall clock. */
  now?: () => string
  /** Injectable id generator. Defaults to ULID. */
  newId?: () => Ulid
  /** Default actor recorded on events. */
  by?: ActorId
  /** D3 provenance stamped on every emitted event (transport/trust). Omitted ⇒ no `prov` field. */
  prov?: Provenance
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
  private readonly prov: Provenance | undefined
  /** Delivery idempotency token stamped on emitted events for the duration of a `withClientToken` scope. */
  private activeClientToken: string | undefined

  constructor(
    private readonly store: EventStore,
    opts: TrackOptions = {},
  ) {
    this.clock = opts.now ?? (() => new Date().toISOString())
    this.newId = opts.newId ?? (() => ulid())
    this.actor = opts.by ?? 'system'
    // Snapshot prov once into an inert, caller-detached value (flat object: primitives only), so a
    // mutable/live prov passed by the caller can never make events carry divergent provenance.
    this.prov = opts.prov ? { ...opts.prov } : undefined
  }

  /** Materialized state from a full replay of the log. */
  state(): State {
    return fold(this.store.readAll())
  }

  /**
   * Run `fn` (one command) with `token` stamped on every event it emits — the delivery idempotency key
   * (v2.3c). Scoped (restored in `finally`), so it stamps exactly this command's batch and nothing else.
   * `undefined` ⇒ no token (today's behavior). Not nested by the ingest seam.
   */
  withClientToken<T>(token: string | undefined, fn: () => T): T {
    const prev = this.activeClientToken
    this.activeClientToken = token
    try {
      return fn()
    } finally {
      this.activeClientToken = prev
    }
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
    if (input.kind === 'decision') {
      if (!state.decisions.has(input.ref)) {
        throw new DomainError(`a decision blocker's ref must be an existing decision (${input.ref})`)
      }
    } else if (!state.items.has(input.ref)) {
      throw new DomainError(`unknown ref item ${input.ref}`)
    }
    const blockerId = this.newId()
    const resolutionRule: ResolutionRule | undefined =
      input.kind === 'dependency' ? (input.resolutionRule ?? 'linked-done') : undefined
    // `linked-accepted` is now resolved by the commit-relative projection (v2.2a hybrid-A):
    // openness = ref not accepted at the report's baselineCommit (revocable). See report/blocker-status.ts.
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
    // Idempotency (v2.1). A report asserts ONE result per test, so we (1) collapse intra-report
    // duplicates for the same (evidenceId, commit, env, runner) to the LAST asserted result, then
    // (2) emit a run only when that result differs from the LATEST already in the log for the tuple.
    // ⇒ a true re-ingest (even of a malformed `[pass, fail]` same-test report) is a no-op; a genuine
    // cross-report transition — incl. a flaky recovery pass→fail→pass — is recorded; `latestRun`
    // never goes false-green on fail→pass→fail.
    const tupleKey = (evidenceId: string, commit: string, env: string, runner: string): string =>
      JSON.stringify([evidenceId, commit, env, runner]) // collision-proof key (one shared builder)

    // (a) latest result per tuple already in the log (replayed in order; later overwrites earlier).
    const logLatest = new Map<string, RunResult>()
    for (const e of this.store.readAll()) {
      if (e.type !== 'acceptance.run') continue
      const p = e.payload as Record<string, unknown>
      const { evidenceId, commit, env, runner, result } = p
      if (
        typeof evidenceId !== 'string' ||
        typeof commit !== 'string' ||
        typeof env !== 'string' ||
        typeof runner !== 'string' ||
        (result !== 'pass' && result !== 'fail')
      ) {
        continue // malformed acceptance.run payload — ignore for dedup
      }
      logLatest.set(tupleKey(evidenceId, commit, env, runner), result)
    }

    // (b) collapse THIS report to the last result per tuple, preserving first-seen order.
    const reportResult = new Map<string, RunResult>()
    const order: Array<{ key: string; itemId: ItemId; evidenceId: string }> = []
    for (const entry of parseRunReport(content, format)) {
      // A locator may be shared by several evidence — one run per evidence.
      for (const evidence of state.evidence.values()) {
        if (evidence.locator !== entry.locator) continue
        const criterion = state.criteria.get(evidence.criterionId)
        if (!criterion) continue
        const key = tupleKey(evidence.id, run.commit, run.env, run.runner)
        if (!reportResult.has(key)) order.push({ key, itemId: criterion.itemId, evidenceId: evidence.id })
        reportResult.set(key, entry.result) // last assertion wins within the report
      }
    }

    // (c) emit only the tuples whose asserted result changes the log.
    const parts: EventPart[] = []
    for (const { key, itemId, evidenceId } of order) {
      const result = reportResult.get(key)!
      if (logLatest.get(key) === result) continue // unchanged vs log → idempotent skip
      parts.push({
        aggregate: 'item',
        aggregateId: itemId,
        type: 'acceptance.run',
        payload: { evidenceId, commit: run.commit, env: run.env, runner: run.runner, result },
      })
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

  // ---- BRANCH.md import (SPEC §5) ----

  /**
   * Idempotent, read-only import of a `BRANCH.md` file: derive a parent `feature` Item + one
   * `chore` Item per lot (resolved by stable `sourceKey = branchSlug/lotSlug`), map lot `[x]`→done
   * and nested UAT checkboxes → acceptance criteria (`[x]` → a manual pass run). Re-import emits
   * ONLY deltas (survives lot reordering) and NEVER writes the file. Returns the change counts.
   */
  importBranch(
    content: string,
    opts: { locator: string; fileSlug?: string; commit?: string },
  ): ImportResult {
    const parsed = parseBranch(content, opts.fileSlug !== undefined ? { fileSlug: opts.fileSlug } : {})
    const sourceHash = computeHash(content)
    const link: Link = { kind: 'branch.md', locator: opts.locator }
    let created = 0
    let updated = 0

    const findBySourceKey = (sourceKey: string): ItemState | undefined =>
      [...this.state().items.values()].find((i) => i.sourceKey === sourceKey)

    const feature = findBySourceKey(parsed.branchSlug)
    const featureId =
      feature?.id ??
      this.createItem({
        kind: 'feature',
        title: parsed.feature.title || parsed.branchSlug,
        workspace: parsed.branchSlug,
        sourceKey: parsed.branchSlug,
        links: [link],
        ...(parsed.feature.body ? { body: parsed.feature.body } : {}),
      })
    if (!feature) created++

    for (const lot of parsed.lots) {
      const lotKey = `${parsed.branchSlug}/${lot.lotSlug}`
      const item = findBySourceKey(lotKey)
      const lotId =
        item?.id ??
        this.createItem({
          kind: 'chore',
          title: lot.title,
          workspace: parsed.branchSlug,
          parentId: featureId,
          sourceKey: lotKey,
          links: [link],
        })
      if (!item) created++

      // checkbox -> realization (forward only; `done` is terminal, so an unchecked lot stays done)
      if (lot.done) {
        const current = this.state().items.get(lotId)!.realization
        if (current === 'to-do') {
          this.setRealization(lotId, 'in-progress')
          this.setRealization(lotId, 'done')
          updated++
        } else if (current === 'in-progress') {
          this.setRealization(lotId, 'done')
          updated++
        }
      }

      // nested UAT -> acceptance criterion (resolved by stable uatSlug; + a manual pass run when [x])
      for (const uat of lot.uat) {
        const existing = [...this.state().criteria.values()].find(
          (c) => c.itemId === lotId && slugify(c.statement) === uat.uatSlug,
        )
        if (existing) {
          // delta: a UAT newly checked [x] records a manual pass run if not already passing
          if (uat.passed) {
            const evidence = [...this.state().evidence.values()].find(
              (e) => e.criterionId === existing.id,
            )
            if (evidence?.latestRun?.result !== 'pass') {
              const evidenceId =
                evidence?.id ??
                this.linkEvidence(existing.id, 'manual', `${opts.locator}#${uat.uatSlug}`)
              this.recordRun(evidenceId, {
                commit: opts.commit ?? 'HEAD',
                env: 'uat',
                runner: 'manual',
                result: 'pass',
              })
              updated++
            }
          }
          continue
        }
        const criterionId = this.addCriterion(lotId, uat.statement)
        const evidenceId = this.linkEvidence(criterionId, 'manual', `${opts.locator}#${uat.uatSlug}`)
        if (uat.passed) {
          this.recordRun(evidenceId, {
            commit: opts.commit ?? 'HEAD',
            env: 'uat',
            runner: 'manual',
            result: 'pass',
          })
        }
        created++
      }
    }

    // provenance — emitted only when the import actually changed something (no-op re-import is silent)
    if (created + updated > 0) {
      this.emit('item', featureId, 'branch.imported', {
        locator: opts.locator,
        branchSlug: parsed.branchSlug,
        sourceHash,
        // Structural signature of the reconciled projection — drives v2.0 freshness (read contract).
        // Pass the RESOLVED branchSlug (fileSlug-aware) so the stamp matches the real sourceKeys.
        structureHash: branchSignature(content, parsed.branchSlug),
      })
    }

    return { branchSlug: parsed.branchSlug, featureId, created, updated }
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
      ...(this.prov !== undefined ? { prov: this.prov } : {}),
      ...(this.activeClientToken !== undefined ? { clientToken: this.activeClientToken } : {}),
      payload: part.payload,
    }))
    if (events.length > 1) {
      this.store.appendCommand(events, { cmdId: this.newId() })
    } else {
      this.store.appendCommand(events)
    }
  }
}
