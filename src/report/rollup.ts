// Workpackages §2 — the `%`-by-WP rollup (pure). Builds the WP forest from `role:'workpackage'`
// items + `parentId`, then, for each WP/sub-WP, rolls up its TRANSITIVE NON-WP LEAF descendants via
// `bucketOf`:
//   done    = DONE leaves
//   active  = DONE + TO-DO + AWAITED leaves          (the denominator)
//   dropped = DROPPED leaves                          (shown, EXCLUDED from %)
//   pct     = round(done / active * 100), with 0/0 ⇒ 'n/a' (never 100%)
// Parent counts are the SUM of descendant leaves, NEVER the mean of child percentages (Simpson trap).
// Each node's dotted display label (`WP1`, `WP1.1`) is DERIVED from tree position, never stored.

import { acceptanceStatus } from '../accept/status.js'
import type { ActorId } from '../events/types.js'
import type { AcceptanceStatus } from '../model/acceptance.js'
import type { BlockerKind, BlockerScope, BlockerState, ResolutionRule } from '../model/blocker.js'
import { isRoleContainer, type BlockerId, type ItemId, type ItemKind, type ItemState, type Realization, type SpecStatus } from '../model/item.js'
import type { State } from '../state/fold.js'
import { bucketOf, type Bucket, type ReportConfig } from './buckets.js'
import { effectiveOpenBlockersForItem } from './blocker-status.js'

/**
 * preconisation-actionnable (DESIGN §1) — the projection of ONE open blocker onto a leaf. `ref` =
 * decisionId / intra-dep item; `engagementRef` = the h2a engagement of an `extra` dep. Carries enough for
 * the directive to be DELEGABLE (a bare boolean `awaitedOnDecision` is not — it lacks the decisionId).
 */
export interface WpLeafBlocker {
  blockerId: BlockerId
  kind: BlockerKind
  ref?: ItemId
  scope?: BlockerScope
  resolutionRule?: ResolutionRule
  engagementRef?: string
  reason: string
}

/** A rolled-up leaf under a WP — its bucket drives both the % counts and the `[x]/[ ]` checkbox. */
export interface WpLeaf {
  id: ItemId
  title: string
  bucket: Bucket
  kind: ItemKind
  // preconisation-actionnable (DESIGN §1) — additive enrichment, all DERIVED here (acceptanceStatus +
  // effectiveOpenBlockersForItem), so the directive selector recomputes NOTHING.
  workspace: string
  realization: Realization
  acceptance: AcceptanceStatus
  /** WSJF score of the latest priority assessment, when one exists (the value proxy). */
  priority?: number
  specStatus: SpecStatus | 'n/a'
  accountable?: ActorId
  /** Every open blocker on this leaf, projected (kind/ref/scope/resolutionRule/engagementRef/reason). */
  openBlockers: WpLeafBlocker[]
  /** Present ⇒ an h2a ENGAGEMENT backs this leaf (report-revamp: ATTENDUS disposition signal). */
  engagementRef?: string
  /** An open blocker on this leaf is `kind:'decision'` ⇒ an owner decision is pending (ATTENDUS). */
  awaitedOnDecision?: boolean
}

/** Project an open `BlockerState` onto the leaf's `openBlockers[]` (drop-absent ⇒ minimal shape). */
function projectBlocker(b: BlockerState): WpLeafBlocker {
  return {
    blockerId: b.id,
    kind: b.kind,
    reason: b.reason,
    ...(b.ref !== undefined ? { ref: b.ref } : {}),
    ...(b.scope !== undefined ? { scope: b.scope } : {}),
    ...(b.resolutionRule !== undefined ? { resolutionRule: b.resolutionRule } : {}),
    ...(b.engagementRef !== undefined ? { engagementRef: b.engagementRef } : {}),
  }
}

/**
 * Build ONE rolled-up `WpLeaf` from a non-WP item — the SINGLE place every directive fact is derived
 * (bucket + acceptance + open blockers), shared by `computeWpTree` and `statusByLevel` so the enrichment
 * never drifts between the two consumers. PURE over `(state, item, config)`.
 */
export function buildWpLeaf(state: State, item: ItemState, config: ReportConfig): WpLeaf {
  const bucket = bucketOf(state, item, config)
  const open = effectiveOpenBlockersForItem(state, item.id, config.baselineCommit)
  const acceptance = acceptanceStatus(state, item.id, config.baselineCommit)
  // An open `kind:'decision'` blocker ⇒ an OWNER decision is pending (report-revamp ATTENDUS).
  const awaitedOnDecision = bucket === 'AWAITED' && open.some((b) => b.kind === 'decision')
  return {
    id: item.id,
    title: item.title,
    bucket,
    kind: item.kind,
    workspace: item.workspace,
    realization: item.realization,
    acceptance,
    specStatus: item.specStatus,
    openBlockers: open.map(projectBlocker),
    ...(item.priority !== undefined ? { priority: item.priority.score } : {}),
    ...(item.accountable !== undefined ? { accountable: item.accountable } : {}),
    ...(item.engagementRef !== undefined ? { engagementRef: item.engagementRef } : {}),
    ...(awaitedOnDecision ? { awaitedOnDecision: true } : {}),
  }
}

/** A node in the rolled-up WP forest. `id`/`title` are identity; `label` is the derived dotted code. */
export interface WpNode {
  id: ItemId
  title: string
  /** Derived dotted display label from tree position (e.g. "WP1", "WP1.2"). */
  label: string
  /** DONE non-WP leaf descendants (transitive). */
  done: number
  /** DONE + TO-DO + AWAITED non-WP leaf descendants — the % denominator. */
  active: number
  /** DROPPED non-WP leaf descendants — shown, excluded from %. */
  dropped: number
  /** round(done/active*100); 'n/a' when active is 0 (never 100%). */
  pct: number | 'n/a'
  /** The non-WP leaves attached at THIS node (descendants not under a nested sub-WP), for the checkbox view. */
  leaves: WpLeaf[]
  children: WpNode[]
}

/** A CONTAINER node (workpackage OR spec-phase) — descended through, never a leaf (Scope §B(a)). */
function isWp(item: ItemState): boolean {
  return isRoleContainer(item)
}

/**
 * Tally leaf buckets into done/active/dropped counts (the % numerator/denominator). DONE counts in both
 * done and active; TO-DO/AWAITED count active only; DROPPED is shown but EXCLUDED from the denominator.
 * Exported so `statusByLevel` rolls up tiers with the SAME arithmetic (no Simpson mean-of-pcts trap).
 */
export function tally(leaves: readonly WpLeaf[]): { done: number; active: number; dropped: number } {
  let done = 0
  let active = 0
  let dropped = 0
  for (const l of leaves) {
    if (l.bucket === 'DONE') {
      done++
      active++
    } else if (l.bucket === 'TO-DO' || l.bucket === 'AWAITED') {
      active++
    } else {
      dropped++ // DROPPED — shown, excluded from %
    }
  }
  return { done, active, dropped }
}

/**
 * Build the WP forest and roll leaf buckets up. A WP's transitive NON-WP descendants are its leaves;
 * a nested WP is a sub-node, not a leaf, so its leaves count once at every ancestor (SUM, not mean).
 */
export function computeWpTree(state: State, config: ReportConfig): WpNode[] {
  const items = [...state.items.values()]
  // children index: parentId → its direct children (stable by id for deterministic labels/order).
  const childrenOf = new Map<ItemId | undefined, ItemState[]>()
  for (const item of items) {
    const key = item.parentId
    const list = childrenOf.get(key) ?? []
    list.push(item)
    childrenOf.set(key, list)
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.id.localeCompare(b.id))

  // Collect every NON-WP leaf descendant of `node`, but STOP at a nested sub-WP boundary (those leaves
  // belong to the sub-WP's own node). A non-WP container (e.g. a feature with chore children) is descended
  // through — it is not itself a leaf. This is the set "directly attached" at `node`.
  const directLeaves = (node: ItemId): WpLeaf[] => {
    const out: WpLeaf[] = []
    const walk = (parentId: ItemId): void => {
      for (const child of childrenOf.get(parentId) ?? []) {
        if (isWp(child)) continue // a sub-WP boundary — its leaves count under IT, not here
        const grandkids = childrenOf.get(child.id) ?? []
        if (grandkids.length === 0) {
          out.push(buildWpLeaf(state, child, config)) // DESIGN §1 — all directive facts derived once here
        } else walk(child.id) // non-WP container — descend
      }
    }
    walk(node)
    return out
  }

  // Roll up one WP: its direct leaves + the recursive sum from every nested sub-WP (SUM, never mean-of-pcts).
  const build = (wp: ItemState, label: string): WpNode => {
    const leaves = directLeaves(wp.id)
    const children: WpNode[] = []
    // Sub-WPs are the DIRECT WP descendants (a sub-WP nested under a non-WP container still counts here).
    let wpOrdinal = 0
    const collectSubWps = (parentId: ItemId): void => {
      for (const child of childrenOf.get(parentId) ?? []) {
        if (isWp(child)) {
          wpOrdinal++
          children.push(build(child, `${label}.${wpOrdinal}`))
        } else {
          collectSubWps(child.id) // descend through a non-WP container to find a sub-WP beneath it
        }
      }
    }
    collectSubWps(wp.id)

    // Counts SUM this node's direct leaves with every descendant node's counts.
    const self = tally(leaves)
    const done = self.done + children.reduce((s, c) => s + c.done, 0)
    const active = self.active + children.reduce((s, c) => s + c.active, 0)
    const dropped = self.dropped + children.reduce((s, c) => s + c.dropped, 0)

    return {
      id: wp.id,
      title: wp.title,
      label,
      done,
      active,
      dropped,
      pct: active === 0 ? 'n/a' : Math.round((done / active) * 100),
      leaves,
      children,
    }
  }

  // Roots = WPs whose parent is not itself a WP (a top-level WP, or a WP whose parent is a plain item).
  const isWpById = new Map(items.map((i) => [i.id, isWp(i)]))
  const roots = items.filter((i) => isWp(i) && !(i.parentId !== undefined && isWpById.get(i.parentId)))
  roots.sort((a, b) => a.id.localeCompare(b.id))
  return roots.map((wp, idx) => build(wp, `WP${idx + 1}`))
}
