// Scope §B(b) — `track scope validate`: a PURE, read-only, fail-closed, ADVISORY validation over the
// folded track state. It NEVER glob-matches (string-level set logic only), NEVER ingests, NEVER appends,
// and is NEVER a commit gate — it RENDERS a verdict the harness owns the path side of. The fail-closed
// staleness gate (requireFresh/StaleSidecarError) is handled by the caller (TrackReader.scopeValidate),
// which runs it FIRST; this module is reached only on a fresh (or no-sidecar) read.

import { computeHash } from '../events/canonical.js'
import { isRoleContainer, type ItemId, type ItemState } from '../model/item.js'
import type { VerificationRun, Verdict } from '../model/verification.js'
import type { State } from '../state/fold.js'
import { bucketOf, type ReportConfig } from '../report/buckets.js'

/** A semantic validation finding (advisory). `wpId` names the offending WP/spec-phase when applicable. */
export type ScopeFindingCode =
  | 'scope-undeclared' // a realization-active WP/spec-phase with no scope declaration
  | 'incoherent' // a declared scope whose allowed∩forbidden globs overlap (string-level set overlap)
  | 'illegal-nesting' // a spec-phase whose parent is neither a WP nor a spec-phase (a folded-state anomaly)
  | 'claim-out-of-phase' // a claimed item is not a descendant of the declared phase
  | 'delivered-out-of-scope' // (opt-in) a done WP whose latest VerificationRun is a violation

export interface ScopeFinding {
  code: ScopeFindingCode
  wpId?: ItemId
  message: string
}

/** The per-WP/phase semantic state (the worst single condition; 'ok' when none apply). */
export type SemanticStatus = 'ok' | 'scope-undeclared' | 'incoherent' | 'illegal-nesting'

/** The latest ingested VerificationRun verdict for a WP, surfaced (READ, never recomputed). */
export type EvidenceStatus = Verdict

export interface PerWp {
  wpId: ItemId
  label: string
  declared: boolean
  latestVerification?: VerificationRun
  semanticStatus: SemanticStatus
  evidenceStatus?: EvidenceStatus
}

export type ScopeValidateStatus = 'pass' | 'fail' | 'stale' | 'missing'

export interface ScopeValidateResult {
  status: ScopeValidateStatus
  findings: ScopeFinding[]
  perWp: PerWp[]
  /** Deterministic hash of the (sorted) declared scopes in scope — present iff at least one is declared. */
  scopeRevisionHash?: string
}

export interface ScopeValidateInput {
  workspace: string
  baselineCommit: string
  /** Opt-in: infer 'delivered-out-of-scope' (a read flag, never a write). OFF by default. */
  inferDeliveredOutOfScope?: boolean
  /** Optional claimed item id — flag if it is not a descendant of its WP/phase's declared subtree. */
  claimedItemId?: ItemId
}

/**
 * Is a container (WP/spec-phase) "realization-active" — does it have at least one ACTIVE (non-dropped,
 * non-`done`) descendant leaf? An undeclared scope is only flagged for an active container (a finished
 * or empty one has no work the harness would verify). Reuses `bucketOf` (no new bucket logic).
 */
function isRealizationActive(
  state: State,
  containerId: ItemId,
  childrenOf: Map<ItemId | undefined, ItemState[]>,
  config: ReportConfig,
): boolean {
  let found = false
  const walk = (parentId: ItemId): void => {
    if (found) return
    for (const child of childrenOf.get(parentId) ?? []) {
      if (found) return
      if (isRoleContainer(child)) {
        walk(child.id) // descend through a nested container
        continue
      }
      const grandkids = childrenOf.get(child.id) ?? []
      if (grandkids.length === 0) {
        const bucket = bucketOf(state, child, config)
        if (bucket === 'TO-DO' || bucket === 'AWAITED') found = true
      } else {
        walk(child.id) // non-container container — descend
      }
    }
  }
  walk(containerId)
  return found
}

/** True iff the container's latest run (or all leaves) is `done` and none active — for the opt-in inference. */
function allLeavesDone(
  state: State,
  containerId: ItemId,
  childrenOf: Map<ItemId | undefined, ItemState[]>,
  config: ReportConfig,
): boolean {
  let any = false
  let allDone = true
  const walk = (parentId: ItemId): void => {
    for (const child of childrenOf.get(parentId) ?? []) {
      if (isRoleContainer(child)) {
        walk(child.id)
        continue
      }
      const grandkids = childrenOf.get(child.id) ?? []
      if (grandkids.length === 0) {
        any = true
        if (bucketOf(state, child, config) !== 'DONE') allDone = false
      } else {
        walk(child.id)
      }
    }
  }
  walk(containerId)
  return any && allDone
}

/** Is `itemId` a (transitive) descendant of `ancestorId`? */
function isDescendant(state: State, itemId: ItemId, ancestorId: ItemId): boolean {
  for (let cursor: ItemId | undefined = state.items.get(itemId)?.parentId; cursor !== undefined; ) {
    if (cursor === ancestorId) return true
    cursor = state.items.get(cursor)?.parentId
  }
  return false
}

/**
 * Validate scope declarations over the folded `state`, scoped to `workspace`. PURE: no glob-matching
 * (allowed∩forbidden is a string-level set overlap), no ingest, no append. The caller guarantees freshness.
 */
export function scopeValidate(state: State, input: ScopeValidateInput): ScopeValidateResult {
  const config: ReportConfig = { baselineCommit: input.baselineCommit, requireAccepted: false }
  const items = [...state.items.values()]

  // children index: parentId → direct children (id-sorted for deterministic labels — same as the rollup).
  const childrenOf = new Map<ItemId | undefined, ItemState[]>()
  for (const item of items) {
    const list = childrenOf.get(item.parentId) ?? []
    list.push(item)
    childrenOf.set(item.parentId, list)
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.id.localeCompare(b.id))

  // Derive the dotted WP-forest label per container (same walk as status-by-level). Roots = containers
  // whose parent is not itself a container.
  const isContainerById = new Map(items.map((i) => [i.id, isRoleContainer(i)]))
  const roots = items.filter(
    (i) => isRoleContainer(i) && !(i.parentId !== undefined && isContainerById.get(i.parentId)),
  )
  roots.sort((a, b) => a.id.localeCompare(b.id))
  const labelOf = new Map<ItemId, string>()
  const visit = (c: ItemState, label: string): void => {
    labelOf.set(c.id, label)
    let ordinal = 0
    const collect = (parentId: ItemId): void => {
      for (const child of childrenOf.get(parentId) ?? []) {
        if (isRoleContainer(child)) {
          ordinal++
          visit(child, `${label}.${ordinal}`)
        } else collect(child.id)
      }
    }
    collect(c.id)
  }
  // A2 — partition the root labels by class (`workpackage`→`WP<n>`, `stream`→`S<n>`) so a WP nested under a
  // stream is labelled relatively (`S1.1`), consistent with computeWpTree. No-stream ⇒ byte-identical.
  let wpN = 0
  let streamN = 0
  roots.forEach((c) => visit(c, c.role === 'stream' ? `S${++streamN}` : `WP${++wpN}`))

  // Latest VerificationRun per wpRef (read, never recomputed): latest by `at` then `runId`.
  const latestRunByWp = new Map<ItemId, VerificationRun>()
  for (const run of state.verificationRuns.values()) {
    if (run.wpRef === undefined) continue
    const prev = latestRunByWp.get(run.wpRef)
    if (prev === undefined || run.at > prev.at || (run.at === prev.at && run.runId > prev.runId)) {
      latestRunByWp.set(run.wpRef, run)
    }
  }

  // A2 — scope (INERT path globs) is declarable ONLY on a `workpackage`/`spec-phase` (see Track.declareScope);
  // a `stream` (epic) is a CONTAINER but is NOT scope-declarable, so it must NOT enter this set — otherwise a
  // realization-active stream with no scope would fire a FALSE `scope-undeclared` finding. The tree-walk
  // helpers (isRealizationActive/allLeavesDone) still DESCEND THROUGH a stream via isRoleContainer; only the
  // per-container scope FINDINGS exclude it.
  const isScopeDeclarable = (i: ItemState): boolean => i.role === 'workpackage' || i.role === 'spec-phase'
  const containers = items
    .filter((i) => isScopeDeclarable(i) && i.workspace === input.workspace)
    .sort((a, b) => a.id.localeCompare(b.id))

  const findings: ScopeFinding[] = []
  const perWp: PerWp[] = []
  const declaredScopes: Array<{ wpId: ItemId; scope: unknown }> = []

  for (const c of containers) {
    const declared = c.scope !== undefined
    let semanticStatus: SemanticStatus = 'ok'

    // illegal-nesting: a spec-phase whose parent is neither a WP nor a spec-phase (a folded-state anomaly;
    // the write path forbids this, so it only fires on a hand-edited/foreign log — fail-closed surfacing).
    if (c.role === 'spec-phase' && c.parentId !== undefined) {
      const parent = state.items.get(c.parentId)
      // A spec-phase's legal parents are STRICTLY workpackage|spec-phase — NOT `isRoleContainer` (which since
      // A2 also includes `stream`; a spec-phase must never nest under a stream).
      if (parent === undefined || (parent.role !== 'workpackage' && parent.role !== 'spec-phase')) {
        semanticStatus = 'illegal-nesting'
        findings.push({ code: 'illegal-nesting', wpId: c.id, message: `spec-phase ${c.id} is not nested under a workpackage or spec-phase` })
      }
    }

    if (declared) {
      declaredScopes.push({ wpId: c.id, scope: c.scope })
      // incoherent: a glob present in BOTH allowed and forbidden (string-level set overlap, NOT a path match).
      const allowed = new Set(c.scope!.allowed ?? [])
      const overlap = (c.scope!.forbidden ?? []).filter((g) => allowed.has(g))
      if (overlap.length > 0 && semanticStatus === 'ok') {
        semanticStatus = 'incoherent'
        findings.push({
          code: 'incoherent',
          wpId: c.id,
          message: `scope on ${c.id} lists ${overlap.length} glob(s) as both allowed and forbidden: ${overlap.join(', ')}`,
        })
      }
    } else if (isRealizationActive(state, c.id, childrenOf, config) && semanticStatus === 'ok') {
      // scope-undeclared: a realization-active container with no scope declaration.
      semanticStatus = 'scope-undeclared'
      findings.push({ code: 'scope-undeclared', wpId: c.id, message: `${c.role} ${c.id} is realization-active but has no scope declaration` })
    }

    const latest = latestRunByWp.get(c.id)
    perWp.push({
      wpId: c.id,
      label: labelOf.get(c.id) ?? c.id,
      declared,
      semanticStatus,
      ...(latest !== undefined ? { latestVerification: latest, evidenceStatus: latest.verdict } : {}),
    })
  }

  // claim-out-of-phase: an explicit claimed item must be a descendant of a DECLARED phase/WP it belongs to.
  if (input.claimedItemId !== undefined) {
    const claimed = state.items.get(input.claimedItemId)
    if (claimed !== undefined && claimed.workspace === input.workspace) {
      const ownerDeclared = containers.some(
        (c) => c.scope !== undefined && (c.id === claimed.parentId || isDescendant(state, claimed.id, c.id)),
      )
      if (!ownerDeclared) {
        findings.push({
          code: 'claim-out-of-phase',
          message: `claimed item ${claimed.id} is not a descendant of any declared scope phase`,
        })
      }
    }
  }

  // Opt-in delivered-out-of-scope inference: a container whose leaves are all done but whose latest
  // VerificationRun is a violation. A READ flag — never a write, OFF by default.
  if (input.inferDeliveredOutOfScope === true) {
    for (const c of containers) {
      const latest = latestRunByWp.get(c.id)
      if (latest?.verdict === 'violation' && allLeavesDone(state, c.id, childrenOf, config)) {
        findings.push({
          code: 'delivered-out-of-scope',
          wpId: c.id,
          message: `${c.role} ${c.id} is delivered (all leaves done) but its latest verification is a violation`,
        })
      }
    }
  }

  const status: ScopeValidateStatus =
    containers.length === 0 ? 'missing' : findings.length > 0 ? 'fail' : 'pass'

  return {
    status,
    findings,
    perWp,
    ...(declaredScopes.length > 0
      ? { scopeRevisionHash: computeHash(declaredScopes.sort((a, b) => a.wpId.localeCompare(b.wpId))) }
      : {}),
  }
}
