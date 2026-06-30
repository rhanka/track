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
import { isRoleContainer, type BlockerId, type ItemId, type ItemKind, type ItemRole, type ItemState, type Realization, type SpecStatus } from '../model/item.js'
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
  /**
   * The display label. By DEFAULT the DERIVED dotted code from tree position (e.g. "WP1", "WP1.2"); when
   * this node carries a durable `code` (WP-codes A1) the label IS that code VERBATIM (the derived `WP<n>`
   * counter then SKIPS any ordinal a `^WP\d+$` code claims). The `string` type is unchanged — a label may
   * now be an assigned code instead of a positional `WP<n>`.
   */
  label: string
  /**
   * WP-codes (DESIGN A1, additive/optional) — the durable assigned `code` of this container, when present
   * (= `ItemState.code`). Absent ⇒ the label is the derived positional `WP<n>`/dotted code (byte-identical
   * to the pre-codes rollup). A DISPLAY label, NEVER an identity — `id` stays the ULID.
   */
  code?: string
  /**
   * A2 (DESIGN wp-codes-and-stream-role §A2, additive/optional) — present + `'stream'` ONLY when this node is
   * a `stream` (epic) container, so a machine consumer distinguishes a stream node (labelled `S<n>`) from a
   * workpackage node (labelled `WP<n>`) WITHOUT parsing the label prefix (fragile once a stream carries a
   * code). DROP-WHEN-ABSENT for a `workpackage`/`spec-phase` node ⇒ a no-stream forest is byte-identical to
   * the pre-A2 rollup. A DISPLAY classifier, NEVER an identity (`id` stays the ULID; a stream is never a wpRoot).
   */
  role?: ItemRole
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
  /**
   * WP-codes A3 (DESIGN §A3, additive/optional) — `true` iff this container's OWN realization is a DROPPED
   * one (`cancelled`/`rejected`, buckets.ts:26). A "terminal" WP — abandoned, not delivered. A DONE root is
   * NEVER terminal (a delivered WP stays a WP). DERIVED (never stored); drop-when-absent ⇒ a forest with no
   * terminal container is byte-identical to the pre-A3 rollup. The `--active-roster` render option OMITS the
   * terminal ROOTS from the human roster; a machine consumer reads this flag to filter the forest itself.
   */
  terminal?: boolean
  /**
   * DESIGN R3a — set ONLY after a workspace leaf-clip (`clipWpTreeToWorkspace`) when this node's subtree
   * contained ≥1 leaf in ANOTHER workspace that the clip excluded. The counts/`pct` then reflect the clipped
   * workspace's PART, never the node's true cross-workspace total. Absent ⇒ the counts are the full total
   * (a mono-workspace tree never sets it ⇒ byte-identical to the pre-clip rollup).
   */
  partial?: boolean
}

/**
 * DESIGN R1 — the wpRoot of an item: the HIGHEST ancestor (incl. self) whose `role === 'workpackage'`
 * STRICT (NOT `isRoleContainer`, which also matches `spec-phase` — a spec-phase is NEVER a wpRoot), walking
 * `parentId`. Nested sub-WPs ⇒ the topmost workpackage wins. Pure, O(depth), terminating (a `seen` guard
 * defends against a malformed cycle even though append's cycle-guard already prevents one). Returns
 * `undefined` for an unknown item or one with no workpackage ancestor.
 */
export function wpRootId(items: Map<ItemId, ItemState>, itemId: ItemId): ItemId | undefined {
  let highest: ItemId | undefined
  const seen = new Set<ItemId>()
  let cursor: ItemId | undefined = itemId
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    const item = items.get(cursor)
    if (item === undefined) break
    if (item.role === 'workpackage') highest = cursor // keep climbing; the LAST (topmost) WP wins
    cursor = item.parentId
  }
  return highest
}

/**
 * DESIGN R3a — a TRUE leaf-clip of a rolled-up WP forest to ONE workspace. Pure over a computed tree:
 *   - keep only the leaves with `leaf.workspace === workspace` (drop foreign leaves — no leak);
 *   - keep a node iff ≥1 such leaf remains in its (clipped) subtree, else PRUNE it (closes the ghost-orphan
 *     loss the old node-filter caused for W leaves under a V-rooted WP);
 *   - RECOMPUTE done/active/dropped/pct from the clipped leaves + surviving children (never the global total);
 *   - mark `partial` when the clip excluded any leaf from this node's subtree.
 * Labels are preserved from the source tree (a WP keeps its global identity across per-workspace views).
 * NON-BREAKING: a mono-workspace tree drops nothing ⇒ the output is deep-equal to the input (no `partial`).
 */
export function clipWpTreeToWorkspace(tree: readonly WpNode[], workspace: string): WpNode[] {
  const clipNode = (node: WpNode): WpNode | null => {
    const leaves = node.leaves.filter((l) => l.workspace === workspace)
    const children = node.children.map(clipNode).filter((c): c is WpNode => c !== null)
    const self = tally(leaves)
    const done = self.done + children.reduce((s, c) => s + c.done, 0)
    const active = self.active + children.reduce((s, c) => s + c.active, 0)
    const dropped = self.dropped + children.reduce((s, c) => s + c.dropped, 0)
    const clippedTotal = active + dropped
    if (clippedTotal === 0) return null // no W leaf anywhere in this subtree ⇒ prune the node
    const fullTotal = node.active + node.dropped // the node's true (pre-clip) leaf total
    const partial = clippedTotal < fullTotal
    return {
      id: node.id,
      title: node.title,
      label: node.label,
      // WP-codes (DESIGN A1) — carry the code across the clip (drop-when-absent ⇒ no-code byte-identical).
      ...(node.code !== undefined ? { code: node.code } : {}),
      // A2 — carry the stream classifier across the clip (drop-when-absent ⇒ no-stream byte-identical).
      ...(node.role !== undefined ? { role: node.role } : {}),
      done,
      active,
      dropped,
      pct: active === 0 ? 'n/a' : Math.round((done / active) * 100),
      leaves,
      children,
      // WP-codes A3 — carry the terminal flag across the clip (drop-when-absent ⇒ non-terminal byte-identical).
      ...(node.terminal !== undefined ? { terminal: node.terminal } : {}),
      ...(partial ? { partial: true } : {}),
    }
  }
  return tree.map(clipNode).filter((n): n is WpNode => n !== null)
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
          // WP-codes (DESIGN A1) — a coded sub-WP renders its `code` VERBATIM; else the positional dotted
          // label. The ordinal still advances per sub-WP position, so a sibling's dotted label is unchanged
          // (no-code ⇒ byte-identical).
          children.push(build(child, child.code ?? `${label}.${wpOrdinal}`))
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
      // WP-codes (DESIGN A1) — surface the durable code (drop-when-absent ⇒ a no-code node is byte-identical).
      ...(wp.code !== undefined ? { code: wp.code } : {}),
      // A2 — surface the stream classifier ONLY on a stream node (drop-when-absent ⇒ a WP/spec-phase node is
      // byte-identical to the pre-A2 rollup; a consumer reads this, never the `S`/`WP` label prefix).
      ...(wp.role === 'stream' ? { role: wp.role } : {}),
      done,
      active,
      dropped,
      pct: active === 0 ? 'n/a' : Math.round((done / active) * 100),
      leaves,
      children,
      // WP-codes A3 (DESIGN §A3) — DERIVE the terminal flag from THIS container's own realization (DROPPED ⇒
      // abandoned). Drop-when-absent ⇒ a non-terminal node is byte-identical to the pre-A3 rollup.
      ...(wp.realization === 'cancelled' || wp.realization === 'rejected' ? { terminal: true } : {}),
    }
  }

  // Roots = WPs whose parent is not itself a WP (a top-level WP, or a WP whose parent is a plain item).
  const isWpById = new Map(items.map((i) => [i.id, isWp(i)]))
  const roots = items.filter((i) => isWp(i) && !(i.parentId !== undefined && isWpById.get(i.parentId)))
  roots.sort((a, b) => a.id.localeCompare(b.id))
  // WP-codes (DESIGN A1, the PRINCIPE PORTEUR) — DECOUPLE stability from numbering. A root with a `code`
  // renders it VERBATIM; a root WITHOUT one takes the next DERIVED `WP<n>` whose ordinal `n` is NOT already
  // claimed by a `^WP\d+$` code on ANY coded container (root OR nested sub-WP — the same display class). The
  // scan spans EVERY role-container, not just roots: a `WP5` code on a SUB-WP renders `WP5` verbatim too, so
  // it must reserve ordinal 5 against the uncoded roots or the two would collide on display (this mirrors the
  // widened `assertCodeUnique` scan in track.ts). ⇒ a no-code roster = `WP1..WPN` BYTE-IDENTICAL (the scan
  // finds nothing); an all-coded roster = its codes exactly; a mixed roster = codes + `WP<n>` filling the
  // gaps WITHOUT collision. Order stays stable by ULID; a code is a display label only (a recode never
  // re-packs the derived sequence, and the derived `WP<n>` can never collide with a code because it skips
  // claimed ordinals).
  // A2 (DESIGN wp-codes-and-stream-role §A2) — PARTITION the roster by container class. `workpackage` roots
  // take the derived `WP<n>` sequence; `stream` roots take a SEPARATE derived `S<n>` sequence (the whole
  // point — DS's 7 streams render S1..S7, never WP1..WP7). Each class SKIPS the ordinals its OWN code
  // namespace claims (`^WP\d+$` for WP, `^S\d+$` for streams — the A1 principe porteur, applied per class).
  // A WP directly UNDER a stream is NOT a top-level root (its parent stream is a container, so the `roots`
  // filter excludes it) ⇒ it consumes NO `WP<n>` ordinal; it is labelled RELATIVELY by the EXISTING dotted
  // recursion (`S1.1`, `S1.2`), NOT a `S1.WP1` grammar. ⇒ a no-stream roster numbers `WP1..WPN`
  // BYTE-IDENTICAL (the S sequence stays empty; the WP path is the pre-A2 derivation, unchanged).
  const claimedWp = new Set<number>()
  const claimedStream = new Set<number>()
  for (const item of items) {
    if (!isWp(item)) continue // only role-containers carry a code; scan ALL of them, not just roots
    const code = item.code ?? ''
    const mw = /^WP(\d+)$/.exec(code)
    if (mw) claimedWp.add(Number(mw[1]))
    const ms = /^S(\d+)$/.exec(code)
    if (ms) claimedStream.add(Number(ms[1]))
  }
  let wpCounter = 1
  let streamCounter = 1
  const rootLabel = (r: ItemState): string => {
    if (r.code !== undefined) return r.code // verbatim; a `^WP\d+$`/`^S\d+$` code reserved its ordinal above
    if (r.role === 'stream') {
      while (claimedStream.has(streamCounter)) streamCounter++ // SKIP every S ordinal a code claimed
      return `S${streamCounter++}`
    }
    while (claimedWp.has(wpCounter)) wpCounter++ // SKIP every WP ordinal a code claimed
    return `WP${wpCounter++}`
  }
  return roots.map((wp) => build(wp, rootLabel(wp)))
}
