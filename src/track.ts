import { ulid } from 'ulid'

import { EventStore } from './events/store.js'
import type { ActorId, Aggregate, CommandEvent, EventType, Provenance, TrackEvent, Ulid } from './events/types.js'
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
  type BlockerScope,
  type ResolutionRule,
} from './model/blocker.js'
import {
  assertDossierArtifact,
  assertOutcomeTransition,
  type DecisionCreatedPayload,
  type DossierArtifact,
  type Dossier,
  type Outcome,
} from './model/decision.js'
import {
  assertRealizationTransition,
  assertRoleNesting,
  assertScopeDecl,
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
  type ScopeDecl,
  type SpecStatus,
} from './model/item.js'
import { assertVerificationRun, type VerificationRecordedPayload } from './model/verification.js'
import { assertSpecAmend, type SpecAmendPayload } from './model/spec-amend.js'
import {
  assertDemandRaised,
  assertDemandTransition,
  assertDispositionOutcome,
  type DemandId,
  type DemandRaisedPayload,
  type DemandRef,
  type DemandStatus,
} from './model/demand.js'
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

/**
 * Under-lock idempotency hook (the ingest workspace-scoped path). Receives a command's `inputs` and the
 * just-read `existing` log UNDER THE STORE LOCK; returns the persisted originals to dedup (append nothing,
 * return them verbatim) or `null` to append normally. See `EventStore.appendCommand`'s `dedupe` opt.
 */
export type DedupeHook = (
  inputs: ReadonlyArray<CommandEvent>,
  existing: readonly TrackEvent[],
) => TrackEvent[] | null

/**
 * Under-lock DOMAIN-LEGALITY recheck (demand-lifecycle Mode A, F2). Receives a command's `inputs` and the
 * just-read `existing` log UNDER THE STORE LOCK; re-folds it and re-asserts the demand transition (+ the
 * duplicateOf containment); MUST THROW (a DomainError) when the command is no longer legal against the
 * now-current state. Scoped to the new Mode A demand commands. See `EventStore.appendCommand`'s `recheck` opt.
 */
export type RecheckHook = (inputs: ReadonlyArray<CommandEvent>, existing: readonly TrackEvent[]) => void

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

/** Resolution scope for `resolveExternalDependency` — REQUIRED so unscoped resolution is never implicit.
 *  `{workspace}` = pin to one workspace (the ingest channel's containment); `'all-workspaces'` = a local
 *  CLI human (the trust root) explicitly opting out of the pin. */
export type ResolveScope = { workspace: string } | 'all-workspaces'

export interface OpenBlockerInput {
  targetId: ItemId
  kind: BlockerKind
  ref?: ItemId // required for `intra` deps + `decision` blockers; MUST be omitted for an `extra` dep
  reason: string
  resolutionRule?: ResolutionRule
  owner?: ActorId
  scope?: BlockerScope // dependency only; absent ⇒ `intra`
  engagementRef?: string // required iff scope === 'extra'
}

/**
 * Acceptance-freshness lifecycle — PURE eligibility predicate for `consolidate` (SYNTHESIS §5): an item is
 * consolidation-eligible iff it is `done` AND accepted-at-its-OWN-commits = it has ≥1 criterion AND EVERY
 * criterion's LATEST run is `pass` (evaluated off the folded state, at each run's OWN commit — NOT against the
 * moving baseline/HEAD; using `acceptanceStatus` against HEAD would re-introduce the treadmill bug). A
 * criterion is accepted-at-own-commit iff it has ≥1 evidence whose latest run is `pass` AND none whose latest
 * run is `fail` AND none with no run yet (un-run). A `waived`-only criterion has NO pass run ⇒ NOT accepted
 * (so the item is ineligible). A not-`done` item, a zero-criteria item, or ANY non-pass criterion ⇒ ineligible
 * ⇒ consolidate SKIPS it ENTIRELY (no anchor, no re-stamp). Reads only the folded `State`; emits nothing.
 */
export function isConsolidationEligible(state: State, itemId: ItemId): boolean {
  const item = state.items.get(itemId)
  if (item === undefined || item.realization !== 'done') return false
  const criteria = [...state.criteria.values()].filter((c) => c.itemId === itemId)
  if (criteria.length === 0) return false // zero-criteria done item ⇒ nothing to heal ⇒ ineligible
  return criteria.every((c) => {
    const evidence = [...state.evidence.values()].filter((e) => e.criterionId === c.id)
    if (evidence.length === 0) return false // a criterion with no evidence has no pass run ⇒ not accepted
    if (evidence.some((e) => e.latestRun === undefined)) return false // un-run evidence ⇒ not accepted
    if (evidence.some((e) => e.latestRun!.result === 'fail')) return false // a live fail ⇒ not accepted
    return evidence.every((e) => e.latestRun!.result === 'pass') // every evidence latest = pass
  })
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
  /**
   * Under-lock idempotency hook for the active scope (the ingest workspace-scoped path). When set, it is
   * passed straight through to `EventStore.appendCommand`'s `dedupe` opt, so a concurrent retry that
   * bypassed the ingest fast-path is deduped UNDER THE LOCK keyed on `(workspace, clientToken)` — stable
   * across a re-minted aggregateId. Absent ⇒ the store's default `(clientToken, aggregateId)` backstop.
   */
  private activeDedupe: DedupeHook | undefined
  /**
   * Under-lock DOMAIN-LEGALITY recheck for the active scope (demand-lifecycle Mode A, F2 semantic-race
   * guard). SCOPED to the new Mode A demand commands: when set (via `withDemandRecheck`), it is passed to
   * `EventStore.appendCommand`'s `recheck` opt so the demand transition (+ duplicateOf containment) is
   * re-asserted UNDER THE LOCK against the now-current folded log — rejecting a cross-actor race the
   * per-aggregate lock does not cover. Absent for every existing append path (unchanged).
   */
  private activeRecheck: RecheckHook | undefined

  constructor(
    private readonly store: EventStore,
    opts: TrackOptions = {},
  ) {
    this.clock = opts.now ?? (() => new Date().toISOString())
    this.newId = opts.newId ?? (() => ulid())
    this.actor = opts.by ?? 'system'
    // Snapshot prov once into an inert, FULLY caller-detached value, so a mutable/live prov passed by
    // the caller can never make events carry divergent provenance. `structuredClone` deep-copies the
    // nested `sig` (M3) — a shallow spread would share `sig` by reference and reopen the D3 mutation hole.
    this.prov = opts.prov ? structuredClone(opts.prov) : undefined
  }

  /** Materialized state from a full replay of the log. */
  state(): State {
    return fold(this.store.readAll())
  }

  /**
   * Run `fn` (one command) with `token` stamped on every event it emits — the delivery idempotency key
   * (v2.3c). Scoped (restored in `finally`), so it stamps exactly this command's batch and nothing else.
   * `undefined` ⇒ no token (today's behavior). Not nested by the ingest seam.
   *
   * `opts.dedupe` (the ingest path) installs an under-lock idempotency hook for the same scope, plumbed
   * straight to `EventStore.appendCommand`. It lets ingest key the concurrent-retry dedup on
   * `(workspace, clientToken)` — stable across a re-minted aggregateId — instead of the store's default
   * `(clientToken, aggregateId)`. Restored in `finally` alongside the token.
   */
  withClientToken<T>(token: string | undefined, fn: () => T, opts: { dedupe?: DedupeHook } = {}): T {
    const prevToken = this.activeClientToken
    const prevDedupe = this.activeDedupe
    this.activeClientToken = token
    this.activeDedupe = opts.dedupe
    try {
      return fn()
    } finally {
      this.activeClientToken = prevToken
      this.activeDedupe = prevDedupe
    }
  }

  createItem(input: ItemCreatedPayload): ItemId {
    if (input.kind === 'decision') {
      throw new DomainError('use createDecision for kind:"decision" (Lot 3) — it needs targets, a dossier, and an atomic blocker batch (SPEC §2.5)')
    }
    // Role nesting invariant (Scope §B(a)): a WP nests only under a WP; a spec-phase only under a WP or
    // spec-phase; a non-role leaf under anything. A parentless container (root) and a non-role leaf under
    // anything stay allowed. Unknown-parent is left to fold/report (createItem does not validate parent
    // existence — branch-import sets parentId before the parent has folded), so we guard ONLY when the
    // parent is present in state.
    if (input.role !== undefined && input.parentId !== undefined) {
      const parent = this.state().items.get(input.parentId)
      if (parent !== undefined) assertRoleNesting(input.role, parent.role, '<new>', input.parentId)
    }
    const itemId = this.newId()
    // Result id = the PERSISTED event's aggregateId. On a fresh append that IS `itemId`; on a concurrent-
    // retry dedup it is the ORIGINAL persisted item's id (the under-lock hook re-minted-aggregateId-blind),
    // so a racing create-retry returns the first writer's id, never this attempt's never-persisted one.
    const [persisted] = this.emit('item', itemId, 'item.created', { ...input })
    return (persisted?.aggregateId as ItemId) ?? itemId
  }

  /**
   * Move an item under a new parent — or detach it to root when `parentId` is omitted (Workpackages
   * §2). Appends `item.reparented` on the EXISTING item aggregate (next seq, no recreate; existing
   * hashes untouched). Guards (all reject with DomainError BEFORE any append): the item exists; the
   * parent exists if given; both share the SAME workspace; no self-parent; no cycle (the new parent
   * must not be the item or a transitive descendant of it). Binding-gated at the ingest seam.
   */
  reparentItem(itemId: ItemId, parentId?: ItemId): void {
    const state = this.state()
    const item = state.items.get(itemId)
    if (!item) throw new DomainError(`unknown item ${itemId}`)
    if (parentId !== undefined) {
      if (parentId === itemId) throw new DomainError(`cannot reparent item ${itemId} under itself`)
      const parent = state.items.get(parentId)
      if (!parent) throw new DomainError(`unknown parent item ${parentId}`)
      if (parent.workspace !== item.workspace) {
        throw new DomainError(
          `cannot reparent across workspaces: item ${itemId} is in "${item.workspace}", parent ${parentId} is in "${parent.workspace}"`,
        )
      }
      // Role nesting invariant (Scope §B(a)): a `role:'workpackage'` item may only nest under another
      // workpackage; a `role:'spec-phase'` only under a workpackage or spec-phase. A non-role leaf may
      // still parent under a container or a leaf (back-compat with branch-import's feature→chore).
      // Detaching to root (parentId undefined) stays allowed (this block only runs when a parent is given).
      assertRoleNesting(item.role, parent.role, itemId, parentId)
      // Cycle guard: walk the prospective parent's ancestry; reaching `itemId` would close a loop.
      for (let cursor: ItemId | undefined = parentId; cursor !== undefined; ) {
        if (cursor === itemId) {
          throw new DomainError(`cannot reparent item ${itemId} under its own descendant ${parentId} (cycle)`)
        }
        cursor = state.items.get(cursor)?.parentId
      }
    }
    this.emit('item', itemId, 'item.reparented', parentId !== undefined ? { parentId } : {})
  }

  /**
   * Scope §B(a) — set/replace the declarative scope (INERT path globs) on a WP/spec-phase. Appends
   * `scope.declared` on the EXISTING item aggregate (next seq, no recreate; existing hashes untouched),
   * mirroring `item.reparent`→`item.reparented`. Fold sets/replaces `item.scope`. Guards (reject with
   * DomainError BEFORE any append): the item exists AND is role∈{workpackage,spec-phase}. The ScopeDecl
   * shape is validated fail-closed (assertScopeDecl). track STORES the globs, NEVER matches them.
   * Binding-gated (Settles:'always') + workspace-contained at the ingest seam; clientToken via withClientToken.
   */
  declareScope(itemId: ItemId, scope: ScopeDecl, clientToken?: string): void {
    const item = this.state().items.get(itemId)
    if (!item) throw new DomainError(`unknown item ${itemId}`)
    if (item.role !== 'workpackage' && item.role !== 'spec-phase') {
      throw new DomainError(
        `cannot declare scope on item ${itemId}: scope is only declarable on a workpackage or spec-phase (Scope §B(a))`,
      )
    }
    const validated = assertScopeDecl(scope)
    const emit = (): void => {
      this.emit('item', itemId, 'scope.declared', { scope: validated })
    }
    if (clientToken !== undefined) this.withClientToken(clientToken, emit)
    else emit()
  }

  /**
   * M5 (canevas) — record ONE owner-approved LIVE spec amendment on the EXISTING item aggregate (next
   * seq, no recreate; existing hashes untouched), mirroring `item.reparent`→`item.reparented`. Appends
   * `spec.amended`, which folds into `state.specAmendments[itemId]` (RECORD-ONLY: mutates NO spec field
   * destructively — the amendment trace IS the value). The JsonPatch is recorded VERBATIM: track does NOT
   * apply/validate the patch semantics — `baseHash`/`resultHash` are OPAQUE integrity tags (the spec
   * document lives in the host LiveDocument). Guard (reject with DomainError BEFORE any append): the item
   * exists. The payload shape is validated fail-closed (`assertSpecAmend`). An AI proposal carries
   * `prov.proposed:true` + a `proposalRef`; a human/signed amend referencing the same `proposalRef` records
   * ACCEPTANCE WITHOUT laundering the machine origin (both events stay in the `amendmentTrace`). Binding-
   * gated (Settles:'always') + workspace-contained at the ingest seam; `clientToken` via `withClientToken`.
   */
  amendSpec(itemId: ItemId, amend: SpecAmendPayload, clientToken?: string): void {
    if (!this.state().items.has(itemId)) throw new DomainError(`unknown item ${itemId}`)
    const validated = assertSpecAmend({ ...amend, itemId })
    const emit = (): void => {
      this.emit('item', itemId, 'spec.amended', { ...validated })
    }
    if (clientToken !== undefined) this.withClientToken(clientToken, emit)
    else emit()
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
   * Acceptance-freshness lifecycle — re-point an item's realization ANCHOR commit by appending ONE
   * `realization.anchored{itemId, commit, reason?}` on the EXISTING item aggregate (next seq; NO realization
   * transition — `done` stays terminal; existing hashes untouched). Serves realize-time anchoring (`reason:
   * 'realize'`) AND merge-time re-anchoring (`reason:'consolidate'`); the fold takes the LAST anchor (priors
   * stay in the log for audit). The anchor is a READ DETAIL the freshness projection consumes (run-SHA vs
   * anchor-SHA) — it does NOT touch AcceptanceStatus/buckets/gates. Guard (reject BEFORE any append): the
   * item exists (anchoring is restricted to real items; a decision has no realization-anchor axis). Binding-
   * gated (`Settles:'evidence'` — an attributable producer claim, like `acceptance.run`) + `clientToken`-
   * idempotent via `withClientToken`.
   */
  anchorRealization(itemId: ItemId, commit: string, reason?: 'realize' | 'consolidate', clientToken?: string): void {
    if (!this.state().items.has(itemId)) throw new DomainError(`unknown item ${itemId}`)
    const emit = (): void => {
      this.emit('item', itemId, 'realization.anchored', {
        itemId,
        commit,
        ...(reason !== undefined ? { reason } : {}),
      })
    }
    if (clientToken !== undefined) this.withClientToken(clientToken, emit)
    else emit()
  }

  /**
   * Acceptance-freshness lifecycle — the consolidate verb (the squash/rebase HEAL). The `itemIds` are
   * CALLER-AUTHORITATIVE (track has no branch→item link — `branch.imported` is not folded — so it can NEVER
   * infer the branch's item set; the caller/skill supplies it). For each given itemId that is ELIGIBLE
   * (`done` AND accepted-at-its-own-commits — see {@link isConsolidationEligible}):
   *   (a) append `realization.anchored{itemId, commit: mergeCommit, reason:'consolidate'}` — re-anchor; AND
   *   (b) for each of the item's evidence whose LATEST run result is `pass`, re-stamp via the existing
   *       append-only `recordRun(evidenceId, {commit: mergeCommit, env, runner, result:'pass'})` — the heal
   *       that makes the item read `pass` at the landed mergeCommit (an attributable producer claim by the
   *       merging agent's `by`/`prov`, consistent with "track records, never verifies").
   * Eligibility is gated to done+ACCEPTED items only (SYNTHESIS §5): an item that is not done, has ZERO
   * criteria, or has ANY criterion whose LATEST run is not `pass` (fail / un-run / waived-only — a waiver has
   * no pass run, so it is NOT accepted-at-own-commit for re-stamp purposes) is SKIPPED ENTIRELY (no anchor,
   * NO re-stamp). This prevents consolidating a non-accepted (e.g. MIXED [pass, fail]) item.
   * NOTE — the heal is PER-MERGE, not permanent: an item consolidated at merge M1 is fresh at M1 ONLY; the
   * NEXT unrelated merge moves the baseline to M2 and the strict cascade (`accept/status.ts:25`) re-stales it.
   * This is INTENDED (strict-status preserved). The branch-lifecycle SKILL MUST re-run `consolidate` on every
   * subsequent merge that moves HEAD past a consolidated item, else those items re-bucket TO-DO under
   * `requireAccepted` (do NOT "fix" this by reaching back to HEAD-relative acceptance — that is the original bug).
   * APPEND-ONLY: NO mutation/deletion. An unknown item throws BEFORE any append; ineligible items are simply
   * skipped. `clientToken`-idempotent (a retry with the same token+mergeCommit is a no-op via the under-lock
   * dedup / the seam fast-path). Returns nothing — the effect is the appended events.
   */
  consolidate(itemIds: ItemId[], mergeCommit: string, clientToken?: string): void {
    const state = this.state()
    // Guard fail-closed BEFORE any append: every given id must be a real item (track records, explicit target).
    for (const itemId of itemIds) {
      if (!state.items.has(itemId)) throw new DomainError(`unknown item ${itemId}`)
    }
    // Assemble the WHOLE consolidate as ONE atomic command batch (anchor + re-stamps): one `cmdId`, one
    // shared `clientToken` ⇒ a retry with the same token is deduped to the ORIGINAL batch under the lock
    // (Case B of dedupByClientToken / the ingest-seam fast-path). Building the parts up-front (off the
    // initial fold) is safe: each evidence is re-stamped at most once (to mergeCommit), no intra-batch dep.
    const parts: EventPart[] = []
    for (const itemId of itemIds) {
      if (!isConsolidationEligible(state, itemId)) continue // only done+ACCEPTED-at-own-commits items
      // (a) re-anchor on the merge commit (LAST anchor wins).
      parts.push({
        aggregate: 'item',
        aggregateId: itemId,
        type: 'realization.anchored',
        payload: { itemId, commit: mergeCommit, reason: 'consolidate' },
      })
      // (b) re-stamp each evidence whose LATEST run is `pass` (the heal) — an append-only `acceptance.run`
      // at the merge commit (NEVER re-stamp a fail/un-run; skip if already at the merge commit ⇒ no-op).
      for (const criterion of state.criteria.values()) {
        if (criterion.itemId !== itemId) continue
        for (const evidence of state.evidence.values()) {
          if (evidence.criterionId !== criterion.id) continue
          const latest = evidence.latestRun
          if (latest === undefined || latest.result !== 'pass') continue
          if (latest.commit === mergeCommit) continue
          parts.push({
            aggregate: 'item',
            aggregateId: itemId,
            type: 'acceptance.run',
            payload: { evidenceId: evidence.id, commit: mergeCommit, env: latest.env, runner: latest.runner, result: 'pass' },
          })
        }
      }
    }
    if (parts.length === 0) return // nothing to consolidate (no done items / all already healed) — no-op
    const apply = (): void => {
      this.emitBatch(parts)
    }
    if (clientToken !== undefined) this.withClientToken(clientToken, apply)
    else apply()
  }

  // ---- Demand lifecycle (Mode A) — the demand aggregate write path (DESIGN demand-lifecycle-modeA) ----

  /**
   * Raise a demand (`demand.raise` → `demand.raised`) — the durable t=0 capture (the "nothing untracked"
   * guarantee). NON-BINDING (any channel may capture an issue). Creates a new `demand` aggregate in status
   * `raised`. The `raw`/`source` are the immutable capture; the `handler` (who is handling, resolved by
   * precedence `ctx.handler ?? prov.principal ?? by`) is logged on this and every later lifecycle step. The
   * payload is validated fail-closed (assertDemandRaised). Returns the new DemandId.
   */
  raiseDemand(input: {
    type: DemandRaisedPayload['type']
    raw: DemandRaisedPayload['raw']
    source: DemandRaisedPayload['source']
    workspace: string
    handler?: ActorId
    sourceKey?: string
    concerns?: DemandRaisedPayload['concerns']
    links?: DemandRaisedPayload['links']
  }): DemandId {
    const handler = this.resolveHandler(input.handler)
    const validated = assertDemandRaised({ ...input, handler })
    // `workspace` is REQUIRED on the facade — no silent `'ws'` default. A mis-bucketed demand poisons the
    // workspace-keyed dedup + reads; ingest already supplies + enforces it (contract `required`), so this only
    // protects direct facade callers from a silent mis-bucket.
    const { workspace } = input
    const demandId = this.newId()
    // Result id = the PERSISTED event's aggregateId (createItem pattern) — stable under a concurrent-retry dedup.
    const [persisted] = this.emit('demand', demandId, 'demand.raised', { ...validated, workspace })
    return (persisted?.aggregateId as DemandId) ?? demandId
  }

  /**
   * Claim a demand into qualifying (`demand.claim` → `demand.qualifying-started`) — `raised|parked →
   * qualifying`, the mandatory step before any off-ramp (every outcome is attributable to a handler).
   * BINDING. Asserts the transition AT APPEND (the facade fold) AND under the lock (F2 race guard). The
   * `handler` is logged. Re-entrant from `parked` (a re-claim is a new handler attempt / handover).
   */
  claimDemand(demandId: DemandId, opts: { handler?: ActorId; leaseId?: string } = {}): void {
    this.transitionDemand(demandId, 'qualifying', 'demand.qualifying-started', opts.handler, (payload) => {
      if (opts.leaseId !== undefined) payload['leaseId'] = opts.leaseId // Build 2: lease holder
    })
  }

  /**
   * Agree a demand — the ATOMIC PROMOTION (`demand.agree`): emits `demand.agreed` + one `item.created` per
   * promoted item (1..N) as ONE atomic cmdId batch (mirrors createDecision's decision.created+blocker batch)
   * — no window where a demand is agreed without its item(s). BINDING. The transition `qualifying → agreed`
   * is asserted at append AND under the lock (F2). Each promoted item back-links `demandId` and takes the
   * demand's `type` as its `kind` (a defect demand ⇒ a `kind:'defect'` item). The `handler` is logged on the
   * `demand.agreed` fact. Returns the promoted ItemIds (in input order).
   */
  agreeDemand(
    demandId: DemandId,
    input: {
      handler?: ActorId
      items: Array<{ title: string; body?: string; sourceKey?: string; links?: Link[] }>
      qualification?: string
      leaseId?: string
    },
  ): ItemId[] {
    const demand = this.state().demands.get(demandId)
    if (!demand) throw new DomainError(`unknown demand ${demandId}`)
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new DomainError('agreeDemand: a promotion must yield at least one item')
    }
    assertDemandTransition(demand.status, 'agreed')
    const handler = this.resolveHandler(input.handler)
    const itemIds = input.items.map(() => this.newId())
    const parts: EventPart[] = [
      {
        aggregate: 'demand',
        aggregateId: demandId,
        type: 'demand.agreed',
        payload: {
          handler,
          itemIds,
          ...(input.qualification !== undefined ? { qualification: input.qualification } : {}),
          ...(input.leaseId !== undefined ? { leaseId: input.leaseId } : {}), // Build 2: lease holder
        },
      },
    ]
    input.items.forEach((it, i) => {
      parts.push({
        aggregate: 'item',
        aggregateId: itemIds[i]!,
        type: 'item.created',
        payload: {
          kind: demand.type, // a demand's type IS the promoted item's kind (incl. 'defect')
          title: it.title,
          workspace: demand.workspace,
          demandId,
          ...(it.body !== undefined ? { body: it.body } : {}),
          ...(it.sourceKey !== undefined ? { sourceKey: it.sourceKey } : {}),
          ...(it.links !== undefined ? { links: it.links } : {}),
        },
      })
    })
    // F2 under-lock recheck: re-fold the existing log under the lock and re-assert qualifying→agreed.
    const recheck: RecheckHook = (_inputs, existing) => {
      const fresh = fold(existing).demands.get(demandId)
      if (!fresh) throw new DomainError(`unknown demand ${demandId}`)
      assertDemandTransition(fresh.status, 'agreed')
    }
    const persisted = this.withDemandRecheck(recheck, () => this.emitBatch(parts))
    // Result ids = the PERSISTED item.created events' aggregateIds (single source of truth; stable under dedup).
    return persisted.filter((e) => e.type === 'item.created').map((e) => e.aggregateId)
  }

  /**
   * Dispose a demand (`demand.disposition`) — the recorded qualification off-ramp `qualifying →
   * rejected|duplicate|parked`. BINDING. `rejected`/`duplicate` are terminal; `parked` is re-claimable. A
   * `duplicate` MUST carry a `duplicateOf` survivor that is SAME-WORKSPACE and NON-SELF (asserted at append
   * AND under the lock — the cross-demand DEDUP race the per-subject lease does not cover). The `handler` +
   * `reason` are logged.
   */
  disposeDemand(
    demandId: DemandId,
    input: { outcome: DemandStatus; handler?: ActorId; reason: string; duplicateOf?: DemandRef; parkedUntil?: string; leaseId?: string },
  ): void {
    const outcome = assertDispositionOutcome(input.outcome)
    const demand = this.state().demands.get(demandId)
    if (!demand) throw new DomainError(`unknown demand ${demandId}`)
    assertDemandTransition(demand.status, outcome)
    if (outcome === 'duplicate') this.assertDuplicateContainment(demand, input.duplicateOf)
    const handler = this.resolveHandler(input.handler)
    const payload: Record<string, unknown> = {
      outcome,
      handler,
      reason: input.reason,
      ...(input.duplicateOf !== undefined ? { duplicateOf: input.duplicateOf } : {}),
      ...(input.parkedUntil !== undefined ? { parkedUntil: input.parkedUntil } : {}),
      ...(input.leaseId !== undefined ? { leaseId: input.leaseId } : {}), // Build 2: lease holder
    }
    const recheck: RecheckHook = (_inputs, existing) => {
      const state = fold(existing)
      const fresh = state.demands.get(demandId)
      if (!fresh) throw new DomainError(`unknown demand ${demandId}`)
      assertDemandTransition(fresh.status, outcome)
      if (outcome === 'duplicate') this.assertDuplicateContainment(fresh, input.duplicateOf, state)
    }
    this.withDemandRecheck(recheck, () => {
      this.emit('demand', demandId, 'demand.disposition', payload)
    })
  }

  /**
   * Start a spec attempt on a promoted item (`spec.claim` → `spec.started`) — a durable fact of WHO is
   * attempting the item's spec (the `specifying` overlay). BINDING. Recorded on the EXISTING item aggregate
   * (next seq). The `handler` (+ optional `leaseId`/`attemptId`) is logged. Does NOT change specStatus
   * (the spec axis is still driven by `spec.transition`); it is the durable handler/lease fact.
   */
  startSpec(itemId: ItemId, opts: { handler?: ActorId; leaseId?: string; attemptId?: string }): void {
    if (!this.state().items.has(itemId)) throw new DomainError(`unknown item ${itemId}`)
    const handler = this.resolveHandler(opts.handler)
    this.emit('item', itemId, 'spec.started', {
      itemId,
      handler,
      ...(opts.leaseId !== undefined ? { leaseId: opts.leaseId } : {}), // Build 2: lease holder
      ...(opts.attemptId !== undefined ? { attemptId: opts.attemptId } : {}),
    })
  }

  /**
   * Abandon a spec attempt (`spec.abandon` → `spec.abandoned`) — the DURABLE explicit-abandon fact
   * (who/when/why), distinct from a silent lease timeout (ephemeral, Build 2). BINDING. Recorded on the
   * EXISTING item aggregate (next seq). The `handler` + `reason` are logged.
   */
  abandonSpec(itemId: ItemId, opts: { handler?: ActorId; reason: string; leaseId?: string }): void {
    if (!this.state().items.has(itemId)) throw new DomainError(`unknown item ${itemId}`)
    const handler = this.resolveHandler(opts.handler)
    this.emit('item', itemId, 'spec.abandoned', {
      itemId,
      handler,
      reason: opts.reason,
      ...(opts.leaseId !== undefined ? { leaseId: opts.leaseId } : {}), // Build 2: lease holder
    })
  }

  /** Demand lifecycle (Mode A) — the shared single-event transition emitter (claim today; handover later). */
  private transitionDemand(
    demandId: DemandId,
    to: DemandStatus,
    type: EventType,
    handlerInput: ActorId | undefined,
    decorate?: (payload: Record<string, unknown>) => void,
  ): void {
    const demand = this.state().demands.get(demandId)
    if (!demand) throw new DomainError(`unknown demand ${demandId}`)
    assertDemandTransition(demand.status, to)
    const payload: Record<string, unknown> = { handler: this.resolveHandler(handlerInput) }
    if (decorate) decorate(payload)
    const recheck: RecheckHook = (_inputs, existing) => {
      const fresh = fold(existing).demands.get(demandId)
      if (!fresh) throw new DomainError(`unknown demand ${demandId}`)
      assertDemandTransition(fresh.status, to)
    }
    this.withDemandRecheck(recheck, () => {
      this.emit('demand', demandId, type, payload)
    })
  }

  /**
   * Demand lifecycle (Mode A) — the `duplicateOf` containment for a `duplicate` disposition: the survivor
   * must exist (a same-workspace demand or item), be SAME-WORKSPACE as the duplicate, be NON-SELF, AND — when
   * it is a DEMAND — be an actual survivor (its OWN status must NOT itself be terminal `duplicate`/`rejected`).
   * The last guard closes the mutual-duplicate-no-survivor RACE: two actors folding the same pre-lock state can
   * race `dispose A duplicateOf B` and `dispose B duplicateOf A` → both terminal `duplicate` pointing at each
   * other, with NO survivor (real work lost). Re-asserting under the lock (F2) on the now-current fold catches
   * the second writer: when its target has just become terminal-`duplicate`, it is a non-survivor ⇒ reject.
   * An `item` target, or a demand in `qualifying`/`agreed`/`parked`/`raised`, is a valid survivor. `state`
   * defaults to the live fold; the under-lock recheck passes the re-folded log.
   */
  private assertDuplicateContainment(
    demand: { id: DemandId; workspace: string },
    duplicateOf: DemandRef | undefined,
    state: State = this.state(),
  ): void {
    if (duplicateOf === undefined) {
      throw new DomainError('demand.disposition: a duplicate requires a duplicateOf survivor {kind,id}')
    }
    if (duplicateOf.id === demand.id) {
      throw new DomainError(`demand.disposition: a demand cannot be a duplicate of itself (${demand.id})`)
    }
    if (duplicateOf.kind === 'demand') {
      const survivor = state.demands.get(duplicateOf.id)
      if (survivor === undefined) {
        throw new DomainError(`demand.disposition: unknown duplicateOf demand ${duplicateOf.id}`)
      }
      if (survivor.workspace !== demand.workspace) {
        throw new DomainError(
          `demand.disposition: a duplicateOf survivor must be in the same workspace "${demand.workspace}" (got "${survivor.workspace}")`,
        )
      }
      // The survivor must be an actual survivor — a demand whose OWN status is terminal `duplicate`/`rejected`
      // is a NON-SURVIVOR (closes the mutual-duplicate-no-survivor race: pointing at it would lose this demand
      // with no real heir). `qualifying`/`agreed`/`parked`/`raised` are all valid survivors.
      if (survivor.status === 'duplicate' || survivor.status === 'rejected') {
        throw new DomainError(
          `demand.disposition: duplicateOf demand ${duplicateOf.id} is itself ${survivor.status} (a non-survivor) — a duplicate must point at a real survivor`,
        )
      }
      return
    }
    const survivorItem = state.items.get(duplicateOf.id)
    if (survivorItem === undefined) {
      throw new DomainError(`demand.disposition: unknown duplicateOf item ${duplicateOf.id}`)
    }
    if (survivorItem.workspace !== demand.workspace) {
      throw new DomainError(
        `demand.disposition: a duplicateOf survivor must be in the same workspace "${demand.workspace}" (got "${survivorItem.workspace}")`,
      )
    }
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
    // Result id = the PERSISTED batch's first event (decision.created) aggregateId. On a fresh append that
    // IS `decisionId`; on a concurrent-retry dedup it is the ORIGINAL persisted decision's id (the
    // under-lock hook returned the first writer's batch), so a racing create-retry returns the original id,
    // never this attempt's never-persisted one. The decision.created is always parts[0] ⇒ persisted[0].
    const persisted = this.emitBatch(parts)
    return (persisted[0]?.aggregateId as ItemId) ?? decisionId
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
   * Append ONE record-only `DossierArtifact` to a decision's `dossier.artifacts[]` (M5 §3.2) — a
   * pointer to an h2a decision dossier / rendered view / mockup. APPEND-ONLY: emits
   * `decision.artifact-added` on the EXISTING decision aggregate (next seq, no whole-dossier rewrite,
   * existing hashes untouched), avoiding the lost-update hazard of a `reviseDossier` read-modify-write.
   * The union is fail-closed (`assertDossierArtifact`). Track RECORDS the artifact (incl. any named
   * `ComprehensionEvidence`) but NEVER verifies an attestation — the attester (`evidence.subject`) is
   * in the PAYLOAD, distinct from the channel `prov.principal` (the bridge/relayer). Binding-gated +
   * workspace-contained at the ingest seam; `clientToken` idempotency via `withClientToken`.
   */
  addDecisionArtifact(decisionId: ItemId, artifact: DossierArtifact, clientToken?: string): void {
    if (!this.state().decisions.has(decisionId)) {
      throw new DomainError(`unknown decision ${decisionId}`)
    }
    const validated = assertDossierArtifact(artifact)
    const emit = (): void => {
      this.emit('decision', decisionId, 'decision.artifact-added', { artifact: validated })
    }
    // Stamp a CALLER-supplied token (the facade path). When called via the ingest seam the token is
    // already in scope (withClientToken), so a `clientToken` arg is omitted and we must NOT clobber it
    // with `withClientToken(undefined, …)`.
    if (clientToken !== undefined) this.withClientToken(clientToken, emit)
    else emit()
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
    // Lot A: `extra`-scope dependencies reference an h2a ENGAGEMENT (cross-repo/cross-agent), not a local
    // item; `intra` (default) and `decision` keep today's local-ref invariant.
    const scope: BlockerScope = input.kind === 'dependency' ? (input.scope ?? 'intra') : 'intra'
    let resolutionRule: ResolutionRule | undefined

    if (input.kind === 'decision') {
      if (input.ref === undefined || !state.decisions.has(input.ref)) {
        throw new DomainError(`a decision blocker's ref must be an existing decision (${String(input.ref)})`)
      }
    } else if (scope === 'extra') {
      if (input.engagementRef === undefined || input.engagementRef.length === 0) {
        throw new DomainError('an extra-scope dependency blocker requires an engagementRef (an h2a engagement id)')
      }
      if (input.ref !== undefined) {
        throw new DomainError('an extra-scope dependency blocker must NOT carry a local ref (it references the engagementRef)')
      }
      if (input.resolutionRule !== undefined && input.resolutionRule !== 'manual') {
        throw new DomainError(`an extra-scope dependency resolves 'manual' only (got '${input.resolutionRule}') — track cannot see h2a state`)
      }
      resolutionRule = 'manual'
    } else {
      if (input.ref === undefined || !state.items.has(input.ref)) {
        throw new DomainError(`unknown ref item ${String(input.ref)}`)
      }
      // `linked-accepted` openness is resolved by the commit-relative projection (v2.2a hybrid-A);
      // see report/blocker-status.ts.
      resolutionRule = input.resolutionRule ?? 'linked-done'
    }

    const blockerId = this.newId()
    // Result id = the PERSISTED event's aggregateId (createItem pattern). On a fresh append that IS
    // `blockerId`; on a concurrent-retry dedup it is the ORIGINAL persisted blocker's id, so a racing
    // raise-retry returns the first writer's id, never this attempt's never-persisted one.
    const [persisted] = this.emit('blocker', blockerId, 'blocker.opened', {
      blockerId,
      targetId: input.targetId,
      kind: input.kind,
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
      reason: input.reason,
      ...(resolutionRule !== undefined ? { resolutionRule } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(scope === 'extra' ? { scope } : {}),
      ...(input.engagementRef !== undefined ? { engagementRef: input.engagementRef } : {}),
    })
    return (persisted?.aggregateId as BlockerId) ?? blockerId
  }

  resolveBlocker(blockerId: BlockerId): void {
    const blocker = this.state().blockers.get(blockerId)
    if (!blocker) throw new DomainError(`unknown blocker ${blockerId}`)
    assertManualResolve(blocker)
    if (!blocker.open) throw new DomainError(`blocker ${blockerId} is already resolved`)
    // For an `extra` dep, stamp the `engagementRef` onto the resolved event (additive) so an auditor can
    // tie a resolution back to the h2a ENGAGEMENT that triggered it — without re-folding to the opened event.
    this.emit('blocker', blockerId, 'blocker.resolved', {
      blockerId,
      ...(blocker.engagementRef !== undefined ? { engagementRef: blocker.engagementRef } : {}),
    })
  }

  /**
   * Resolve ALL open `extra`-scope dependencies referencing `engagementRef`, as ONE atomic batch — the bulk
   * path for an h2a bridge when an ENGAGEMENT settles (one engagement may block N items). IDEMPOTENT: a
   * retry with nothing open left to resolve is a no-op returning `[]`. Returns the resolved blockerIds.
   *
   * `scope` is REQUIRED and **fail-closed by construction**: the ingest channel passes `{workspace}`
   * (restricts resolution to deps whose target is in that workspace — a pinned channel can never reach
   * another workspace's deps); a local CLI human, who is the trust root, opts into `'all-workspaces'`
   * EXPLICITLY. There is no implicit unscoped path, so a caller that forgets the pin fails to compile
   * rather than silently clearing every workspace's deps.
   */
  resolveExternalDependency(engagementRef: string, scope: ResolveScope): BlockerId[] {
    // Runtime fail-closed (defends against a JS / `as any` caller): the ONLY unscoped path is the literal
    // `'all-workspaces'`. A scope object without a concrete workspace string throws rather than silently
    // resolving every workspace's deps.
    if (scope !== 'all-workspaces' && (typeof scope !== 'object' || scope === null || typeof scope.workspace !== 'string' || scope.workspace.length === 0)) {
      throw new DomainError("resolveExternalDependency: scope must be {workspace:<non-empty string>} or 'all-workspaces'")
    }
    const workspace = scope === 'all-workspaces' ? undefined : scope.workspace
    const state = this.state()
    const parts: EventPart[] = []
    for (const b of state.blockers.values()) {
      if (!b.open || b.kind !== 'dependency' || b.scope !== 'extra' || b.engagementRef !== engagementRef) continue
      if (workspace !== undefined && state.items.get(b.targetId)?.workspace !== workspace) continue
      parts.push({ aggregate: 'blocker', aggregateId: b.id, type: 'blocker.resolved', payload: { blockerId: b.id, engagementRef } })
    }
    // Result ids = the PERSISTED events' aggregateIds (the resolved blockers). These address EXISTING
    // blocker aggregates (no fresh mint), so they are stable regardless of dedup; deriving from the
    // returned events keeps the single-source-of-truth invariant (a deduped retry returns the originals).
    if (parts.length === 0) return []
    return this.emitBatch(parts).map((e) => e.aggregateId)
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
    // Result id = the PERSISTED event's payload.criterionId (payload field, not aggregateId). On a fresh
    // append that IS `criterionId`; on a concurrent-retry dedup it is the ORIGINAL persisted event's id, so
    // a racing add-retry returns the original, never this attempt's never-persisted one.
    const [persisted] = this.emit('item', itemId, 'acceptance.criterion.added', { criterionId, statement })
    return ((persisted?.payload as { criterionId?: string } | undefined)?.criterionId) ?? criterionId
  }

  /**
   * Link an evidence to a criterion. Seam v0 (M2=B): when the caller supplies a DETERMINISTIC `evidenceId`,
   * HONOR it (so the harness can reference it on a same-stream `acceptance.run` without a two-phase read);
   * absent ⇒ mint server-side as today (back-compat). The result id is always derived from the PERSISTED
   * event (stable under a concurrent-retry dedup), so a caller-supplied id round-trips deterministically and
   * a deduped re-link returns the first writer's id.
   */
  linkEvidence(criterionId: string, kind: EvidenceKind, locator: string, evidenceIdInput?: string): string {
    const state = this.state()
    const criterion = state.criteria.get(criterionId)
    if (!criterion) throw new DomainError(`unknown criterion ${criterionId}`)
    if (evidenceIdInput !== undefined && (typeof evidenceIdInput !== 'string' || evidenceIdInput.length === 0)) {
      throw new DomainError('linkEvidence: evidenceId must be a non-empty string when supplied')
    }
    // Seam v0 (M2=B) COLLISION GUARD — a CALLER-SUPPLIED evidenceId must be globally unique. The fold keys
    // `state.evidence` by a bare evidenceId with a blind last-writer-wins set (fold.ts), so a re-used id would
    // SILENTLY re-point the global evidence map (read-model clobber; a later acceptance.run mis-routes/denies).
    // Reject fail-closed BEFORE any append (track philosophy: explicit/resolvable target, never overwrite).
    // A freshly-MINTED id (input absent) is a ULID ⇒ collision-free, so the guard applies ONLY to supplied ids.
    //
    // TOKEN-AWARE (0.12.0 concurrent-retry seam): the guard must NOT fire on MY OWN concurrent retry. The
    // sequential-retry fast-path absorbs a re-delivery UPSTREAM, but a CONCURRENT retry whose pre-lock
    // `tokenIndex` was STALE (miss) proceeds into here, where this FRESH fold now SEES the first writer's
    // committed evidence. If that evidence ORIGINATED from this same delivery (its `originClientToken` equals
    // my `activeClientToken`), it is my own retry — fall through, untouched, and let the under-lock
    // `workspaceDedupe` return the ORIGINAL event (idempotent). Otherwise (different token, OR I am untokened,
    // OR the existing evidence carries no origin token) it is a genuine collision ⇒ throw, fail-closed.
    const existing = evidenceIdInput !== undefined ? state.evidence.get(evidenceIdInput) : undefined
    const isOwnRetry =
      this.activeClientToken !== undefined && existing?.originClientToken === this.activeClientToken
    if (evidenceIdInput !== undefined && existing !== undefined && !isOwnRetry) {
      throw new DomainError(
        `acceptance.link: evidence ${evidenceIdInput} already exists (caller-supplied evidenceId must be unique)`,
      )
    }
    const evidenceId = evidenceIdInput ?? this.newId()
    // Result id = the PERSISTED event's payload.evidenceId. On a fresh append that IS `evidenceId`; on a
    // concurrent-retry dedup it is the ORIGINAL persisted event's evidenceId (the under-lock hook returned
    // the first writer's event), so a racing link-retry returns the original id, never this attempt's
    // freshly-minted (never-persisted) one. evidenceId is a PAYLOAD field, not the aggregateId.
    const [persisted] = this.emit('item', criterion.itemId, 'acceptance.evidence.linked', {
      evidenceId,
      criterionId,
      kind,
      locator,
    })
    return ((persisted?.payload as { evidenceId?: string } | undefined)?.evidenceId) ?? evidenceId
  }

  recordRun(
    evidenceId: string,
    run: { commit: string; env: string; runner: string; result: RunResult },
  ): void {
    this.emit('item', this.evidenceOwner(evidenceId), 'acceptance.run', { evidenceId, ...run })
  }

  /**
   * Scope §B(c) — record ONE path-scope `VerificationRun` (the path-verdict sibling of `recordRun`).
   * EVIDENCE-ONLY: emits `scope.verification-recorded`, which folds into `state.verificationRuns` and
   * touches NO realization/bucket/blocker logic (structural guarantee: a path verdict can NEVER
   * spawn/advance/complete a TODO). Recorded on the wpRef ITEM aggregate (next seq), or — when wpRef is
   * absent — on a synthetic, deterministic `verification:<workspace>` aggregate so a workspace-scoped run
   * has a stable, contiguous-seq home. track NEVER glob-matches: `violations` are recorded VERBATIM as
   * opaque locators. Binding-gated (Settles:'evidence') + workspace-contained at the ingest seam;
   * `clientToken` idempotency via `withClientToken`. `workspace` is REQUIRED only for the wpRef-absent
   * synthetic aggregate; it is ignored when wpRef is present (the item's own workspace governs).
   */
  recordVerification(input: VerificationRecordedPayload, opts: { workspace: string }, clientToken?: string): void {
    const validated = assertVerificationRun(input)
    if (validated.wpRef !== undefined && !this.state().items.has(validated.wpRef)) {
      throw new DomainError(`unknown wpRef item ${validated.wpRef}`)
    }
    const aggregate: Aggregate = validated.wpRef !== undefined ? 'item' : 'verification'
    const aggregateId = validated.wpRef ?? `verification:${opts.workspace}`
    const emit = (): void => {
      this.emit(aggregate, aggregateId, 'scope.verification-recorded', { ...validated })
    }
    if (clientToken !== undefined) this.withClientToken(clientToken, emit)
    else emit()
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
  ): TrackEvent[] {
    return this.emitBatch([{ aggregate, aggregateId, type, payload }])
  }

  /**
   * Append a command's events; a multi-event command is one atomic `cmdId` batch (SPEC §3). Returns the
   * events `appendCommand` actually PERSISTED — the fresh appends, OR (when a concurrent-retry dedup fires)
   * the ORIGINAL persisted events. The single source of truth for a caller's result ids is therefore the
   * log: the ingest seam derives a deduped retry's id from these returned events, never from a
   * freshly-minted (never-persisted) id.
   */
  private emitBatch(parts: EventPart[]): TrackEvent[] {
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
    const dedupeOpt = this.activeDedupe !== undefined ? { dedupe: this.activeDedupe } : {}
    const recheckOpt = this.activeRecheck !== undefined ? { recheck: this.activeRecheck } : {}
    if (events.length > 1) {
      return this.store.appendCommand(events, { cmdId: this.newId(), ...dedupeOpt, ...recheckOpt })
    }
    return this.store.appendCommand(events, { ...dedupeOpt, ...recheckOpt })
  }

  /**
   * Run `fn` (one demand command) with `recheck` installed as the under-lock domain-legality guard (F2).
   * Scoped (restored in `finally`), so it applies to exactly this command's append and nothing else. Used
   * ONLY by the new Mode A demand commands — existing append paths never set it.
   */
  private withDemandRecheck<T>(recheck: RecheckHook, fn: () => T): T {
    const prev = this.activeRecheck
    this.activeRecheck = recheck
    try {
      return fn()
    } finally {
      this.activeRecheck = prev
    }
  }

  /**
   * Demand lifecycle (Mode A) — resolve the handler ("qui traite", the h2a instance id) for a lifecycle
   * step. Precedence: `ctx.handler ?? prov.principal ?? by`. The lease-holder source (the live lease) is
   * Build 2; for now an explicit handler ?? the channel principal ?? the event writer.
   */
  // Build 2: lease holder — `handler = activeLease.holder ?? ctx.handler ?? prov.principal ?? by`.
  private resolveHandler(handler?: ActorId): ActorId {
    return handler ?? this.prov?.principal ?? this.actor
  }
}
