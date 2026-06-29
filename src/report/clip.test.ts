import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { Track } from '../track.js'
import { TrackReader } from '../read/contract.js'
import { computeWpTree, clipWpTreeToWorkspace, type WpNode } from './rollup.js'
import type { ReportConfig } from './buckets.js'

// Lot 0 (DESIGN R3a) — DEFENSIVE leaf-clip of canevas/wpTree. The pre-fix node-filter (node.workspace===W)
// over a GLOBALLY-tallied tree (a) leaks foreign V leaves + a cross-workspace total under a kept W node, and
// (b) silently LOSES W leaves under a V-rooted WP. The fix = a TRUE leaf-clip: count/show only leaves with
// item.workspace===W, keep a node iff ≥1 W-leaf in its subtree, mark the rollup `partial`, recompute AFTER
// pruning. NON-BREAKING: for a mono-workspace tree, leaf-clip ≡ node-filter ⇒ BYTE-IDENTICAL output.

const CFG: ReportConfig = { baselineCommit: 'c1', requireAccepted: false }

let dir: string
let eventsPath: string
let seq = 0

function trackAt(): Track {
  return new Track(new EventStore(eventsPath), {
    by: 'tester',
    now: () => '2026-06-29T00:00:00.000Z',
    newId: () => `id-${String(++seq).padStart(4, '0')}`,
  })
}
const done = (t: Track, id: string): void => {
  t.setRealization(id, 'in-progress')
  t.setRealization(id, 'done')
}

beforeEach(() => {
  seq = 0
  dir = mkdtempSync(join(tmpdir(), 'track-clip-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('clipWpTreeToWorkspace — NON-BREAKING in mono-workspace (byte-identical)', () => {
  it('is the IDENTITY (deep-equal) on a tree whose every leaf is in the clipped workspace', () => {
    const t = trackAt()
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'V', role: 'workpackage' })
    const a = t.createItem({ kind: 'chore', title: 'a', workspace: 'V', parentId: wp })
    t.createItem({ kind: 'chore', title: 'b', workspace: 'V', parentId: wp })
    done(t, a)
    const tree = computeWpTree(t.state(), CFG)
    const clipped = clipWpTreeToWorkspace(tree, 'V')
    expect(clipped).toEqual(tree) // mono-workspace ⇒ leaf-clip ≡ node-filter ≡ identity (no `partial`)
    expect(clipped[0]!.partial).toBeUndefined()
  })
})

describe('clipWpTreeToWorkspace — TRUE leaf-clip in a cross-workspace subtree', () => {
  // WP-V is a V-rooted workpackage holding both V and W leaves (a post-restructure cross-workspace subtree).
  function buildMixed(t: Track): { wpV: string; lW1: string; lW2: string; lV1: string } {
    const wpV = t.createItem({ kind: 'chore', title: 'WP-V', workspace: 'V', role: 'workpackage' })
    const lW1 = t.createItem({ kind: 'chore', title: 'w1', workspace: 'W', parentId: wpV })
    const lW2 = t.createItem({ kind: 'chore', title: 'w2', workspace: 'W', parentId: wpV })
    const lV1 = t.createItem({ kind: 'chore', title: 'v1', workspace: 'V', parentId: wpV })
    done(t, lW1)
    done(t, lW2)
    return { wpV, lW1, lW2, lV1 }
  }

  it('clipping to W keeps the V-ROOTED node, shows ONLY W leaves, and recomputes W-only counts + partial', () => {
    const t = trackAt()
    const { wpV, lW1, lW2, lV1 } = buildMixed(t)
    const tree = computeWpTree(t.state(), CFG)
    // The full (global) rollup tallies ALL leaves.
    expect(tree[0]!).toMatchObject({ id: wpV, done: 2, active: 3 })

    const clipped = clipWpTreeToWorkspace(tree, 'W')
    expect(clipped.length).toBe(1)
    const node = clipped[0]!
    expect(node.id).toBe(wpV) // node RETAINED though its root item is in V (node-filter would have dropped it)
    const ids = node.leaves.map((l) => l.id).sort()
    expect(ids).toEqual([lW1, lW2].sort()) // ONLY the W leaves (no V leak)
    expect(node.leaves.some((l) => l.id === lV1)).toBe(false)
    expect(node).toMatchObject({ done: 2, active: 2, pct: 100, partial: true }) // W-only counts, marked partial
  })

  it('clipping to V keeps only the V leaf and marks partial (the W leaves are excluded)', () => {
    const t = trackAt()
    const { wpV, lV1 } = buildMixed(t)
    const clipped = clipWpTreeToWorkspace(computeWpTree(t.state(), CFG), 'V')
    expect(clipped.length).toBe(1)
    expect(clipped[0]!.leaves.map((l) => l.id)).toEqual([lV1])
    expect(clipped[0]!).toMatchObject({ id: wpV, done: 0, active: 1, pct: 0, partial: true })
  })

  it('prunes a node entirely when its subtree has ZERO leaves in the clipped workspace', () => {
    const t = trackAt()
    buildMixed(t) // only V + W leaves
    const clipped = clipWpTreeToWorkspace(computeWpTree(t.state(), CFG), 'Z')
    expect(clipped).toEqual([]) // no Z leaf anywhere ⇒ the whole forest prunes away
  })
})

describe('canevas — uses the leaf-clip (R3a) instead of the node-filter', () => {
  it('a V-rooted WP holding W leaves SURFACES on canevas(W) (the node-filter would have lost them)', () => {
    const t = trackAt()
    const wpV = t.createItem({ kind: 'chore', title: 'WP-V', workspace: 'V', role: 'workpackage' })
    const lW = t.createItem({ kind: 'chore', title: 'w', workspace: 'W', parentId: wpV })
    done(t, lW)
    const view = new TrackReader(eventsPath).canevas('W', { baselineCommit: 'c1' })
    expect(view.report.wpTree).toBeDefined()
    expect(view.report.wpTree!.length).toBe(1)
    expect(view.report.wpTree![0]!.id).toBe(wpV)
    expect(view.report.wpTree![0]!.leaves.map((l) => l.id)).toEqual([lW])
    expect(view.report.wpTree![0]!.done).toBe(1)
  })

  it('does NOT leak foreign V leaves into canevas(W) and marks the node partial', () => {
    const t = trackAt()
    const wpV = t.createItem({ kind: 'chore', title: 'WP-V', workspace: 'V', role: 'workpackage' })
    const lW = t.createItem({ kind: 'chore', title: 'w', workspace: 'W', parentId: wpV })
    const lV = t.createItem({ kind: 'chore', title: 'v', workspace: 'V', parentId: wpV })
    done(t, lW)
    done(t, lV)
    const node = new TrackReader(eventsPath).canevas('W', { baselineCommit: 'c1' }).report.wpTree![0]!
    expect(node.leaves.map((l) => l.id)).toEqual([lW]) // no V leak
    expect(node.active).toBe(1) // W-only total (not the cross-workspace 2)
    expect(node.partial).toBe(true)
  })

  it('a pure mono-workspace canevas wpTree carries NO partial marker (unchanged behavior)', () => {
    const t = trackAt()
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'W', role: 'workpackage' })
    const a = t.createItem({ kind: 'chore', title: 'a', workspace: 'W', parentId: wp })
    done(t, a)
    const node = new TrackReader(eventsPath).canevas('W', { baselineCommit: 'c1' }).report.wpTree![0]!
    expect(node.partial).toBeUndefined()
    expect(node).toMatchObject({ done: 1, active: 1 })
  })
})
