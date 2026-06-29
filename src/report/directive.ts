// preconisation-actionnable (DESIGN LOCKED) — the DIRECTIVE selector. Replaces the constant
// `préconisation` (which took `leaves[0]` and emitted one frozen phrase per WP) with a DIRECTIVE
// DERIVED from each item's real state, langue-neutre, and DELEGABLE as-is to a subagent.
//
// PURE & ADDITIVE: every fact a directive needs is already on `WpLeaf` (enriched in rollup.ts via
// `acceptanceStatus` + `effectiveOpenBlockersForItem`) — the selector recomputes NOTHING. No new event,
// INGEST unchanged. The enums are a GOVERNED vocabulary (additive only, never renamed; an unknown
// `step.code` degrades to `inspect-fallback` at the renderer — forward-compat, see §3/§7 of the DESIGN).

import type { DecisionRow } from './build.js'
import type { Bucket } from './buckets.js'
import type { WpLeaf, WpLeafBlocker, WpNode } from './rollup.js'
import type { ActorId } from '../events/types.js'
import type { AcceptanceStatus } from '../model/acceptance.js'
import type { ItemId, Realization, SpecStatus } from '../model/item.js'
import type { WorkEventKind } from '../ingest/contract.js'

// ---- the langue-neutre schema (DESIGN §3) ----------------------------------------------------------

export type DirectiveMode = 'human-decision' | 'h2a-engagement' | 'subagent' | 'local'

export type DirectiveGateCode =
  | 'decision-pending'
  | 'engagement-pending'
  | 'external-dependency'
  | 'linked-dependency'
  | 'manual-blocker'
  | 'spec-not-ready'
  | 'acceptance-failed'
  | 'acceptance-stale'
  | 'priority-missing'

export type DirectiveStepCode =
  | 'focus-decision'
  | 'settle-decision'
  | 'resume-engagement'
  | 'resolve-external-blocker'
  | 'amend-spec'
  | 'fix-acceptance'
  | 'rerun-acceptance'
  | 'finish-increment'
  | 'start-increment'
  | 'prioritize-backlog'
  | 'inspect-fallback'

export type DirectiveRank = 'P1_GATE' | 'P2_ACCEPTANCE' | 'P3_IN_PROGRESS' | 'P4_TODO_WSJF' | 'P5_FALLBACK'

export interface DirectiveTarget {
  kind: 'item' | 'decision' | 'blocker' | 'engagement' | 'wp'
  id: ItemId
  title?: string
  workspace?: string
}

export interface DirectiveScope {
  wpId?: ItemId
  wpLabel?: string
}

export interface DirectiveGate {
  code: DirectiveGateCode
  /** ref = decisionId / engagementRef / blockerId — what makes the gate DELEGABLE (not just a boolean). */
  ref?: string
}

export interface DirectiveStep {
  code: DirectiveStepCode
}

export interface DirectiveFacts {
  bucket: Bucket
  realization: Realization
  acceptance: AcceptanceStatus
  wsjf?: number
  specStatus: SpecStatus | 'n/a'
  accountable?: ActorId
  blockerRefs?: string[]
}

/**
 * One actionable, state-derived, delegable directive (DESIGN §3). NO phrase is stored — the human
 * phrasing is generated at render time from `(mode, step, gate)`. `affordances` declare the LEGAL writes
 * (never presumed); `commandHint`, when present, is record/focus/measure ONLY (allowlist, DESIGN §5).
 */
export interface Directive {
  id: string
  target: DirectiveTarget
  scope: DirectiveScope
  mode: DirectiveMode
  gate?: DirectiveGate
  step: DirectiveStep
  rank: DirectiveRank
  facts: DirectiveFacts
  affordances: WorkEventKind[]
  commandHint?: string
}

// ---- record-only commandHint allowlist (DESIGN §5) -------------------------------------------------
// `commandHint` = verbs of MEASURE / ATTENTION / FOCUS only. A directive NEVER hints at fabricating an
// outcome (`item realize <id> done`, `accept … pass|waived`). `affordances` say what is LEGAL; the hint
// never presumes a write. A runtime guard fails closed so a future edit cannot leak a write/pass verb.
const SAFE_HINT = /^track (focus|accept run|blocker raise|priority assess|query|report)\b/
const FORBIDDEN_HINT = /\b(realize|done|pass|waived)\b/

export function assertSafeCommandHint(hint: string | undefined): void {
  if (hint === undefined) return
  if (!SAFE_HINT.test(hint) || FORBIDDEN_HINT.test(hint)) {
    throw new Error(`unsafe commandHint (record-only allowlist violated, DESIGN §5): ${hint}`)
  }
}

// The LEGAL next writes per step (a curated affordance set — what the human/AI MAY submit, never a
// presumed write). Mirrors the monotone facade machines coarsely; the facade re-checks legality.
const AFFORDANCES: Record<DirectiveStepCode, WorkEventKind[]> = {
  'focus-decision': ['decision.outcome'],
  'settle-decision': ['decision.outcome'],
  'resume-engagement': ['blocker.resolve-external'],
  'resolve-external-blocker': ['blocker.resolve', 'blocker.resolve-external'],
  'amend-spec': ['item.spec', 'item.spec-amend'],
  'fix-acceptance': ['acceptance.run'],
  'rerun-acceptance': ['acceptance.run'],
  'finish-increment': ['item.realize'],
  'start-increment': ['item.realize'],
  'prioritize-backlog': ['priority.assess'],
  'inspect-fallback': [],
}

/**
 * Presentation heuristic (NOT a directive field): a decision is "complex enough to warrant a focus
 * session" when it has ≥3 open questions / ≥3 options / any dossier artifact, or simply lacks a
 * recommendation. Drives `focus-decision` vs `settle-decision`. Shared with the renderer (format.ts).
 */
export function decisionNeedsFocus(d: {
  optionCount?: number
  openQuestionCount?: number
  artifacts?: readonly unknown[]
  hasRecommendation?: boolean
}): boolean {
  return (
    (d.openQuestionCount ?? 0) >= 3 ||
    (d.optionCount ?? 0) >= 3 ||
    (d.artifacts?.length ?? 0) > 0 ||
    d.hasRecommendation !== true
  )
}

// ---- the URGENCE ladder (DESIGN §2.B) --------------------------------------------------------------
// First-match-wins over the DELEGABLE leaf (decision/engagement waits already routed OUT). `order` is the
// fine urgency key (lower = more urgent); `rank` is the coarse public label. The ORDER realizes the exact
// DESIGN §2.B sequence: pure-gate > acceptance-fail > in-progress+dep(WIP coincé) > in-progress >
// acceptance-stale > spec-gate > to-do(WSJF) > fallback. D1 resolved (Opus): in-progress > stale.

interface Tier {
  order: number
  rank: DirectiveRank
  step: DirectiveStepCode
  gateCode?: DirectiveGateCode
  gateRef?: string
  blockerRefs: string[]
}

function gateCodeOfDep(b: WpLeafBlocker): DirectiveGateCode {
  if (b.scope === 'extra') return 'external-dependency' // (extra deps are engagement-routed; defensive)
  if (b.resolutionRule === 'manual') return 'manual-blocker'
  return 'linked-dependency'
}

function tierOf(l: WpLeaf): Tier {
  const depBlocker = l.openBlockers.find((b) => b.kind === 'dependency')
  const blockerRefs = l.openBlockers.map((b) => b.blockerId)
  // 1. real blocking gate (dependency/manual blocker open) on a NON-in-progress leaf — P1_GATE.
  if (depBlocker !== undefined && l.realization !== 'in-progress') {
    return { order: 10, rank: 'P1_GATE', step: 'resolve-external-blocker', gateCode: gateCodeOfDep(depBlocker), gateRef: depBlocker.blockerId, blockerRefs }
  }
  // 2. acceptance == 'fail' — P2_ACCEPTANCE (fail sub-rank, primes in-progress).
  if (l.acceptance === 'fail') {
    return { order: 20, rank: 'P2_ACCEPTANCE', step: 'fix-acceptance', gateCode: 'acceptance-failed', blockerRefs: [] }
  }
  // 3. in-progress + open dependency blocker (WIP coincé) — P3_IN_PROGRESS.
  if (depBlocker !== undefined && l.realization === 'in-progress') {
    return { order: 30, rank: 'P3_IN_PROGRESS', step: 'finish-increment', gateCode: gateCodeOfDep(depBlocker), gateRef: depBlocker.blockerId, blockerRefs }
  }
  // 4. in-progress (flux — finish before starting new).
  if (l.realization === 'in-progress') {
    return { order: 40, rank: 'P3_IN_PROGRESS', step: 'finish-increment', blockerRefs: [] }
  }
  // 5. acceptance == 'stale' — P2_ACCEPTANCE (stale sub-rank < fail; soft debt, after WIP). D1.
  if (l.acceptance === 'stale') {
    return { order: 50, rank: 'P2_ACCEPTANCE', step: 'rerun-acceptance', gateCode: 'acceptance-stale', blockerRefs: [] }
  }
  // 6. specStatus demands a spec — spec gate.
  if (l.specStatus === 'to-specify') {
    return { order: 60, rank: 'P1_GATE', step: 'amend-spec', gateCode: 'spec-not-ready', blockerRefs: [] }
  }
  // 7. to-do, ordered by WSJF desc (the value proxy lives in the global tie-break).
  if (l.realization === 'to-do') {
    return { order: 70, rank: 'P4_TODO_WSJF', step: 'start-increment', blockerRefs: [] }
  }
  // 8. fallback — NEVER id-only (the facts always carry bucket/realization/acceptance/specStatus).
  return { order: 90, rank: 'P5_FALLBACK', step: 'inspect-fallback', blockerRefs: [] }
}

function factsOf(l: WpLeaf, blockerRefs: string[]): DirectiveFacts {
  return {
    bucket: l.bucket,
    realization: l.realization,
    acceptance: l.acceptance,
    specStatus: l.specStatus,
    ...(l.priority !== undefined ? { wsjf: l.priority } : {}),
    ...(l.accountable !== undefined ? { accountable: l.accountable } : {}),
    ...(blockerRefs.length > 0 ? { blockerRefs } : {}),
  }
}

/** Stable directive id (deterministic — no flicker): each (kind,target) yields at most one directive. */
function directiveId(target: DirectiveTarget): string {
  return `${target.kind}:${target.id}`
}

function makeDirective(d: Omit<Directive, 'id' | 'affordances'> & { affordances?: WorkEventKind[] }): Directive {
  assertSafeCommandHint(d.commandHint)
  return {
    id: directiveId(d.target),
    affordances: d.affordances ?? AFFORDANCES[d.step.code],
    ...d,
  }
}

// In-WP urgency comparator: order asc, then WSJF desc (undefined LAST), then id (deterministic).
function leafCompare(a: { l: WpLeaf } & Tier, b: { l: WpLeaf } & Tier): number {
  if (a.order !== b.order) return a.order - b.order
  const aw = a.l.priority
  const bw = b.l.priority
  if (aw !== bw) {
    if (aw === undefined) return 1
    if (bw === undefined) return -1
    return bw - aw
  }
  return a.l.id.localeCompare(b.l.id)
}

// Global directive comparator (DESIGN §2.B item 8): urgency `order`, then WSJF desc (undefined LAST),
// then wp.id, then target.id. STRICT determinism — two identical runs yield identical output.
function directiveCompare(a: { directive: Directive; order: number }, b: { directive: Directive; order: number }): number {
  if (a.order !== b.order) return a.order - b.order
  const aw = a.directive.facts.wsjf
  const bw = b.directive.facts.wsjf
  if (aw !== bw) {
    if (aw === undefined) return 1
    if (bw === undefined) return -1
    return bw - aw
  }
  const aWp = a.directive.scope.wpId ?? ''
  const bWp = b.directive.scope.wpId ?? ''
  if (aWp !== bWp) return aWp.localeCompare(bWp)
  return a.directive.target.id.localeCompare(b.directive.target.id)
}

/** Is this leaf in the DELEGABLE scope: open, OR done-but-acceptance∈{fail,stale} (the invisible debt). */
function inDelegableScope(l: WpLeaf): boolean {
  if (l.bucket === 'TO-DO' || l.bucket === 'AWAITED') return true
  // A `done` leaf with fail/stale acceptance is the most precious deletable debt (invisible in DONE when
  // requireAccepted=false). `unknown`/`waived`/`n-a` short-circuit (nothing to re-run / intentional waiver).
  return l.bucket === 'DONE' && (l.acceptance === 'fail' || l.acceptance === 'stale')
}

/**
 * Build the DIRECTIVE set over the WP forest + the decision rows (DESIGN §2/§3). Two ORTHOGONAL axes:
 *   ROUTAGE (mode, per leaf): open `decision` blocker ⇒ `human-decision` (ref=decisionId); an
 *     `engagementRef` on a non-DONE leaf ⇒ `h2a-engagement`; else ⇒ `subagent`.
 *   URGENCE (which leaf, on the delegable subset of each WP): the DESIGN §2.B ladder (`tierOf`).
 *
 * Each leaf is attributed to its OWNING node (`node.leaves` — `directLeaves` already stops at sub-WP
 * boundaries) so a directive maps 1:1 to a leaf with no parent/child double-count. One WORK directive per
 * WP node (its most-urgent delegable leaf), PLUS one directive per decision-wait / engagement-wait /
 * pending decision. The returned array is GLOBALLY sorted (deterministic).
 */
export function buildDirectives(tree: readonly WpNode[], decisions: readonly DecisionRow[] = []): Directive[] {
  const decisionById = new Map(decisions.map((d) => [d.id, d]))
  const flat: WpNode[] = []
  const collect = (n: WpNode): void => {
    flat.push(n)
    for (const c of n.children) collect(c)
  }
  for (const n of tree) collect(n)

  const entries: { directive: Directive; order: number }[] = []
  const seenDecisionRef = new Set<string>() // decisionIds already surfaced via a decision-wait leaf

  for (const node of flat) {
    const scope: DirectiveScope = { wpId: node.id, wpLabel: node.label }
    const work: WpLeaf[] = []

    for (const l of node.leaves) {
      if (!inDelegableScope(l)) continue
      // ROUTAGE — decision wait first, then engagement wait; both leave as their OWN line (not in URGENCE).
      const decisionBlocker = l.openBlockers.find((b) => b.kind === 'decision')
      if (decisionBlocker !== undefined) {
        const decisionId = decisionBlocker.ref ?? ''
        const d = decisionId !== '' ? decisionById.get(decisionId) : undefined
        const focus = d !== undefined ? decisionNeedsFocus(d) : false
        entries.push({
          order: 0,
          directive: makeDirective({
            target: { kind: 'item', id: l.id, title: l.title, workspace: l.workspace },
            scope,
            mode: 'human-decision',
            ...(decisionId !== '' ? { gate: { code: 'decision-pending', ref: decisionId } } : { gate: { code: 'decision-pending' } }),
            step: { code: focus ? 'focus-decision' : 'settle-decision' },
            rank: 'P1_GATE',
            facts: factsOf(l, decisionId !== '' ? [decisionId] : []),
            ...(decisionId !== '' ? { commandHint: `track focus ${decisionId}` } : {}),
          }),
        })
        if (decisionId !== '') seenDecisionRef.add(decisionId)
        continue
      }
      const extraEng = l.openBlockers.find((b) => b.engagementRef !== undefined)
      const engRef = extraEng?.engagementRef ?? (l.bucket !== 'DONE' ? l.engagementRef : undefined)
      if (engRef !== undefined) {
        entries.push({
          order: 1,
          directive: makeDirective({
            target: { kind: 'engagement', id: engRef, title: l.title, workspace: l.workspace },
            scope,
            mode: 'h2a-engagement',
            gate: { code: 'engagement-pending', ref: engRef },
            step: { code: 'resume-engagement' },
            rank: 'P1_GATE',
            facts: factsOf(l, extraEng !== undefined ? [extraEng.blockerId] : []),
          }),
        })
        continue
      }
      work.push(l)
    }

    if (work.length === 0) continue

    // Priorité mix (c) (DESIGN §6): when the WP's whole delegable subset is "all to-do, no WSJF, no
    // discriminant", the to-do/WSJF tier degenerates ⇒ the MISSING priority becomes a delegable action.
    const allPlainTodoNoWsjf = work.every(
      (l) =>
        l.realization === 'to-do' &&
        l.specStatus !== 'to-specify' &&
        l.acceptance !== 'fail' &&
        l.acceptance !== 'stale' &&
        l.openBlockers.length === 0 &&
        l.priority === undefined,
    )
    if (allPlainTodoNoWsjf) {
      const rep = [...work].sort((a, b) => a.id.localeCompare(b.id))[0]!
      entries.push({
        order: 70,
        directive: makeDirective({
          target: { kind: 'item', id: rep.id, title: rep.title, workspace: rep.workspace },
          scope,
          mode: 'subagent',
          gate: { code: 'priority-missing' },
          step: { code: 'prioritize-backlog' },
          rank: 'P4_TODO_WSJF',
          facts: factsOf(rep, []),
          commandHint: `track priority assess ${rep.id}`,
        }),
      })
      continue
    }

    // Most-urgent delegable leaf of this WP (URGENCE ladder + in-WP tie-break).
    const ranked = work.map((l) => ({ l, ...tierOf(l) }))
    ranked.sort(leafCompare)
    const top = ranked[0]!
    entries.push({
      order: top.order,
      directive: makeDirective({
        target: { kind: 'item', id: top.l.id, title: top.l.title, workspace: top.l.workspace },
        scope,
        mode: 'subagent',
        ...(top.gateCode !== undefined
          ? { gate: { code: top.gateCode, ...(top.gateRef !== undefined ? { ref: top.gateRef } : {}) } }
          : {}),
        step: { code: top.step },
        rank: top.rank,
        facts: factsOf(top.l, top.blockerRefs),
      }),
    })
  }

  // Pending DecisionRows NOT already surfaced as a decision-wait (a decision blocking a leaf is covered by
  // that leaf's line). A pending decision with no blocked leaf still needs its own human-decision line.
  for (const d of decisions) {
    if (d.outcome !== 'pending') continue
    if (seenDecisionRef.has(d.id)) continue
    const focus = decisionNeedsFocus(d)
    entries.push({
      order: 0,
      directive: makeDirective({
        target: { kind: 'decision', id: d.id, title: d.title, workspace: d.workspace },
        scope: {},
        mode: 'human-decision',
        gate: { code: 'decision-pending', ref: d.id },
        step: { code: focus ? 'focus-decision' : 'settle-decision' },
        rank: 'P1_GATE',
        facts: {
          bucket: 'AWAITED',
          realization: d.realization,
          acceptance: 'n/a',
          specStatus: 'n/a',
          ...(d.accountable !== undefined ? { accountable: d.accountable } : {}),
          blockerRefs: [d.id],
        },
        commandHint: `track focus ${d.id}`,
      }),
    })
  }

  entries.sort(directiveCompare)
  return entries.map((e) => e.directive)
}

/**
 * The flat, prioritized SUBAGENT dispatch queue (DESIGN §4): the directive ids that are delegable to a
 * subagent, in urgency order. `human-decision` / `h2a-engagement` directives are surfaced in `directives[]`
 * but NOT here — they need a human / an h2a peer, not a subagent. Input is already globally sorted.
 */
export function dispatchQueueOf(directives: readonly Directive[]): string[] {
  return directives.filter((d) => d.mode === 'subagent' || d.mode === 'local').map((d) => d.id)
}
