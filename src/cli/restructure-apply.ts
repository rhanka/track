// DESIGN R5 (Lot 1) — apply a RATIFIED restructuring plan: {itemId→parentId} edges, content-addressed by a
// `planHash`, applied via `item.restructure` (→ `restructureReparent`) through an ingest channel that
// EXPLICITLY grants the default-denied capability. Append-only + clientToken = f(planHash,itemId) ⇒ a replay
// is a no-op via the dedup store. A re-PLAN (different edge map) ⇒ different planHash ⇒ different tokens ⇒
// never falsely skipped. Post-apply GATE (beyond the tautological invariants): (a) intention per edge, (b)
// closure (exactly the plan edges), (c) zero out-of-plan orphan. `done` stays `done`.

import { computeHash } from '../events/canonical.js'
import { EventStore } from '../events/store.js'
import { readHead } from '../events/head.js'
import type { ActorId, TrackEvent } from '../events/types.js'
import { fold } from '../state/fold.js'
import { assertRoleNesting, DomainError } from '../model/item.js'
import { auditFindings } from '../report/audit.js'
import { ingest, type IngestContext } from '../ingest/ingest.js'
import type { WorkEvent, WorkEventKind } from '../ingest/contract.js'

/** One ratified move: place `itemId` under `parentId` (the target). */
export interface RestructureEdge {
  itemId: string
  parentId: string
}

export interface RestructurePlan {
  edges: RestructureEdge[]
  /** Content-address of the COMPLETE edge map. When present it is VERIFIED against the computed hash. */
  planHash?: string
  /**
   * Precondition anchor (the store head the plan was ratified against). MANDATORY for any real write
   * (anti-TOCTOU) — only a clean full replay (every edge already applied) may omit it.
   */
  baseline?: { streamLength?: number; lastContentHash?: string | null }
  /** Optional opaque provenance pointer recorded on each restructure event. */
  restructureRef?: string
}

export interface ApplyResult {
  planHash: string
  /** Total edges in the plan. */
  edges: number
  /** Events written THIS run (0 on a full replay). */
  applied: number
  /** Edges already present from a prior apply (deduped). */
  alreadyApplied: number
}

/**
 * The plan's content hash: canonicalize the edge map (normalized to `{itemId,parentId}`, ORDER-INDEPENDENT
 * via a stable sort) then sha256. A re-plan that changes ANY edge changes the hash ⇒ a fresh token namespace.
 */
export function computePlanHash(edges: readonly RestructureEdge[]): string {
  const norm = edges.map((e) => ({ itemId: e.itemId, parentId: e.parentId })).sort((a, b) => a.itemId.localeCompare(b.itemId))
  return computeHash(norm)
}

function assertPlanShape(plan: RestructurePlan): void {
  if (!Array.isArray(plan.edges) || plan.edges.length === 0) {
    throw new DomainError('restructure apply: the plan must carry at least one {itemId,parentId} edge')
  }
  for (const e of plan.edges) {
    if (typeof e?.itemId !== 'string' || e.itemId.length === 0 || typeof e?.parentId !== 'string' || e.parentId.length === 0) {
      throw new DomainError('restructure apply: each edge needs a non-empty itemId and parentId')
    }
  }
  const children = plan.edges.map((e) => e.itemId)
  if (new Set(children).size !== children.length) {
    throw new DomainError('restructure apply: an item may appear as a child at most once in a plan')
  }
}

/**
 * Apply a ratified plan to the log at `eventsPath`. Throws `DomainError` (nothing written) on: a malformed
 * plan, a planHash mismatch, or a stale baseline. Applies the edges, then runs the post-apply GATE; a gate
 * failure throws AFTER the appends (the append-only log surfaces the incompleteness loudly — the
 * pre-conditions above are what protect "nothing written on bad input").
 */
export function applyRestructurePlan(eventsPath: string, plan: RestructurePlan, opts: { by?: ActorId } = {}): ApplyResult {
  assertPlanShape(plan)
  const planHash = computePlanHash(plan.edges)
  if (plan.planHash !== undefined && plan.planHash !== planHash) {
    throw new DomainError(`restructure apply: planHash mismatch — declared "${plan.planHash}" ≠ computed "${planHash}" (re-plan)`)
  }

  const store = new EventStore(eventsPath)
  const before = store.readAll()
  const state0 = fold(before)

  // Every edge child must exist (precondition).
  for (const e of plan.edges) {
    if (!state0.items.has(e.itemId)) throw new DomainError(`restructure apply: unknown item ${e.itemId} (precondition)`)
    if (!state0.items.has(e.parentId)) throw new DomainError(`restructure apply: unknown parent ${e.parentId} (precondition)`)
  }

  // Baseline precondition is MANDATORY for any real write (anti-TOCTOU): a ratified plan must pin the store
  // head it was computed against. The ONLY no-op exception is a true replay — and "already applied" means
  // THIS plan's exact tokens are already in the log, NOT that parents coincidentally match (a different plan
  // or a manual move could align them; skipping baseline there would let a tokenless write slip the gate).
  const present = new Set(before.filter((ev) => ev.type === 'item.reparented' && ev.clientToken !== undefined).map((ev) => ev.clientToken))
  const allApplied = plan.edges.every((e) => present.has(`${planHash}:${e.itemId}`))
  if (!allApplied) {
    if (plan.baseline?.streamLength === undefined || plan.baseline.lastContentHash === undefined) {
      throw new DomainError('restructure apply: a ratified plan must carry baseline {streamLength, lastContentHash} (anti-TOCTOU precondition)')
    }
    const head = readHead(eventsPath)
    if (plan.baseline.streamLength !== before.length || plan.baseline.lastContentHash !== (head?.lastContentHash ?? null)) {
      throw new DomainError('restructure apply: baseline precondition failed — the store changed since the plan was computed (re-plan)')
    }
  }

  // DRY-RUN the WHOLE plan against the PROSPECTIVE graph (current parents ∪ plan edges) BEFORE any append.
  // An append-only ingest is non-atomic per edge: a later edge failing its append-time guard would leave the
  // earlier edges committed (a partial reorg). Pre-flighting self/role-nesting/cycle over the CUMULATIVE graph
  // here guarantees "nothing written on a bad plan" — and catches a cycle the SEQUENTIAL per-edge checks miss
  // (A→B then B→A: neither edge sees the loop in isolation; the cumulative graph does).
  const prospectiveParent = new Map<string, string | undefined>()
  for (const [id, it] of state0.items) prospectiveParent.set(id, it.parentId)
  for (const e of plan.edges) prospectiveParent.set(e.itemId, e.parentId)
  for (const e of plan.edges) {
    if (e.itemId === e.parentId) throw new DomainError(`restructure apply: cannot parent ${e.itemId} under itself`)
    const item = state0.items.get(e.itemId)!
    const parent = state0.items.get(e.parentId)!
    assertRoleNesting(item.role, parent.role, e.itemId, e.parentId)
    const seen = new Set<string>()
    for (let cur: string | undefined = e.parentId; cur !== undefined; cur = prospectiveParent.get(cur)) {
      if (cur === e.itemId) throw new DomainError(`restructure apply: edge ${e.itemId}→${e.parentId} would create a cycle (prospective graph)`)
      if (seen.has(cur)) break // a pre-existing cycle elsewhere — terminate the walk safely
      seen.add(cur)
    }
  }

  // Group edges by the CHILD's (immutable) workspace — one ingest channel per source workspace, each pinned
  // there + granting `item.restructure`. clientToken = f(planHash,itemId) ⇒ replay dedups to a no-op.
  const byWorkspace = new Map<string, RestructureEdge[]>()
  for (const e of plan.edges) {
    const ws = state0.items.get(e.itemId)!.workspace
    const list = byWorkspace.get(ws) ?? []
    list.push(e)
    byWorkspace.set(ws, list)
  }
  const grant = new Set<WorkEventKind>(['item.restructure'])
  let applied = 0
  for (const [workspace, group] of byWorkspace) {
    const events: WorkEvent[] = group.map((e) => ({
      v: 1,
      kind: 'item.restructure',
      payload: {
        itemId: e.itemId,
        parentId: e.parentId,
        planHash,
        ...(plan.restructureRef !== undefined ? { restructureRef: plan.restructureRef } : {}),
      },
      clientToken: `${planHash}:${e.itemId}`,
    }))
    const ctx: IngestContext = {
      by: opts.by ?? 'human:restructure-apply',
      workspace,
      prov: { transport: 'import', proposed: false, auth: 'local-user' },
      allowedKinds: grant,
    }
    const countBefore = store.readAll().length
    ingest(events, ctx, store)
    applied += store.readAll().length - countBefore
  }

  // ---- post-apply GATE ----
  const after = store.readAll()
  const stateF = fold(after)
  const planChildren = new Set(plan.edges.map((e) => e.itemId))

  // (a) intention — each edge's folded parent === the plan target.
  for (const e of plan.edges) {
    const it = stateF.items.get(e.itemId)
    if (it === undefined || it.parentId !== e.parentId) {
      throw new DomainError(`restructure apply: intention gate failed for ${e.itemId} (folded parent ${String(it?.parentId)} ≠ target ${e.parentId})`)
    }
  }
  // (b) closure — EXACTLY the plan edges produced a reparent (pure + exported for direct testing).
  assertTokenClosure(after, plan.edges, planHash)
  // (c) orphan gate — zero out-of-plan orphan remains (the plan must account for every orphan it touches).
  const outOfPlanOrphans = auditFindings(stateF).filter((f) => f.kind === 'orphan' && f.itemId !== undefined && !planChildren.has(f.itemId))
  if (outOfPlanOrphans.length > 0) {
    throw new DomainError(`restructure apply: orphan gate failed — ${outOfPlanOrphans.length} out-of-plan orphan(s) remain (the plan is incomplete)`)
  }

  return { planHash, edges: plan.edges.length, applied, alreadyApplied: plan.edges.length - applied }
}

/**
 * Post-apply CLOSURE gate (DESIGN R5(b)) — the `item.reparented` events carrying this plan's EXACT namespaced
 * token === EXACTLY the plan edges: exactly one per child, each token NAMING its own aggregate
 * (`${planHash}:${aggregateId}` — defends against a swapped/duplicated token), no duplicate, each to its
 * planned target, each stamped with this planHash. PURE + exported so the airtight gate is directly testable
 * against a hand-crafted (even adversarial) event set, not only the happy path. Throws `DomainError`.
 */
export function assertTokenClosure(
  after: readonly TrackEvent[],
  edges: readonly RestructureEdge[],
  planHash: string,
): void {
  const targetOf = new Map(edges.map((e) => [e.itemId, e.parentId]))
  const exactTokens = new Set(edges.map((e) => `${planHash}:${e.itemId}`))
  const tokened = after.filter(
    (ev) => ev.type === 'item.reparented' && ev.clientToken !== undefined && exactTokens.has(ev.clientToken),
  )
  if (tokened.length !== edges.length) {
    throw new DomainError(`restructure apply: closure gate failed — ${tokened.length} tokened reparent(s) ≠ ${edges.length} plan edge(s)`)
  }
  const seenChild = new Set<string>()
  for (const ev of tokened) {
    if (ev.clientToken !== `${planHash}:${ev.aggregateId}`) {
      throw new DomainError(`restructure apply: closure gate failed — token ${String(ev.clientToken)} is not on its own aggregate ${ev.aggregateId} (swap)`)
    }
    if (!targetOf.has(ev.aggregateId)) throw new DomainError(`restructure apply: closure gate failed — out-of-plan reparent of ${ev.aggregateId}`)
    if (seenChild.has(ev.aggregateId)) throw new DomainError(`restructure apply: closure gate failed — duplicate reparent of ${ev.aggregateId}`)
    seenChild.add(ev.aggregateId)
    if (ev.payload['parentId'] !== targetOf.get(ev.aggregateId)) {
      throw new DomainError(`restructure apply: closure gate failed — ${ev.aggregateId} → ${String(ev.payload['parentId'])} ≠ target ${String(targetOf.get(ev.aggregateId))}`)
    }
    if (ev.payload['planHash'] !== planHash) {
      throw new DomainError(`restructure apply: closure gate failed — ${ev.aggregateId} planHash ${String(ev.payload['planHash'])} ≠ ${planHash}`)
    }
  }
}
