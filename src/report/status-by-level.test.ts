import { describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { Track } from '../track.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type { Ulid } from '../events/types.js'

import { computeWpTree } from './rollup.js'
import { statusByLevel } from './status-by-level.js'

const now = (): string => '2026-06-09T00:00:00.000Z'
const counter = (): (() => Ulid) => {
  let i = 0
  return () => `id-${String(++i).padStart(4, '0')}`
}
const CONFIG = { baselineCommit: 'HEAD', requireAccepted: false }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-level-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/**
 * Build: a ROOT WP (the "spec/plan" tier) containing two nested sub-WPs (the "wp/lot" tier), each with
 * leaves. WP-A: 2 leaves, 1 done. WP-B: 1 leaf, 1 done. Root rolls up 3 leaves, 2 done.
 */
function build(): { track: Track; rootWp: Ulid; wpA: Ulid; wpB: Ulid } {
  const store = new EventStore(join(dir, '.track', 'events.jsonl'))
  const track = new Track(store, { now, newId: counter(), by: 'h', prov: { transport: 'cli', proposed: false, auth: 'local-user' } })
  const rootWp = track.createItem({ kind: 'chore', title: 'Spec Root', workspace: 'ws', role: 'workpackage' })
  const wpA = track.createItem({ kind: 'chore', title: 'WP A', workspace: 'ws', role: 'workpackage', parentId: rootWp })
  const wpB = track.createItem({ kind: 'chore', title: 'WP B', workspace: 'ws', role: 'workpackage', parentId: rootWp })
  const a1 = track.createItem({ kind: 'feature', title: 'a1', workspace: 'ws', parentId: wpA })
  track.createItem({ kind: 'feature', title: 'a2', workspace: 'ws', parentId: wpA })
  const b1 = track.createItem({ kind: 'feature', title: 'b1', workspace: 'ws', parentId: wpB })
  for (const id of [a1, b1]) {
    track.setRealization(id, 'in-progress')
    track.setRealization(id, 'done')
  }
  return { track, rootWp, wpA, wpB }
}

describe('statusByLevel — generalized computeWpTree projection (LOT 2)', () => {
  it("level 'wp' matches the existing computeWpTree forest (parity)", () => {
    const { track } = build()
    const state = track.state()
    const tree = computeWpTree(state, CONFIG)
    const groups = statusByLevel(state, 'wp', CONFIG)
    // 'wp' = every WP node, flattened; counts must match the forest node-for-node.
    const flat: Array<{ id: string; done: number; active: number; dropped: number; pct: number | 'n/a' }> = []
    const walk = (nodes: typeof tree): void => {
      for (const n of nodes) {
        flat.push({ id: n.id, done: n.done, active: n.active, dropped: n.dropped, pct: n.pct })
        walk(n.children)
      }
    }
    walk(tree)
    const got = groups.map((g) => ({ id: g.id, done: g.done, active: g.active, dropped: g.dropped, pct: g.pct })).sort((a, b) => a.id.localeCompare(b.id))
    expect(got).toEqual(flat.sort((a, b) => a.id.localeCompare(b.id)))
  })

  it("level 'task' = the leaf buckets (each leaf one group, status from bucketOf)", () => {
    const { track, wpA } = build()
    const groups = statusByLevel(track.state(), 'task', CONFIG)
    // 5 leaves total (a1,a2,b1) — wait: a1,a2,b1 = 3 leaves.
    expect(groups.length).toBe(3)
    const a1 = groups.find((g) => track.state().items.get(g.id)?.parentId === wpA && g.done === 1)
    expect(a1).toBeDefined()
    // each task group is a single leaf: active=1, done∈{0,1}, pct 0|100
    for (const g of groups) {
      expect(g.active).toBe(1)
      expect([0, 100]).toContain(g.pct)
    }
  })

  it("level 'plan'/'spec' roll up the ROOT tier (sum-not-mean): 3 leaves, 2 done ⇒ 67%", () => {
    const { track, rootWp } = build()
    for (const level of ['plan', 'spec'] as const) {
      const groups = statusByLevel(track.state(), level, CONFIG)
      expect(groups.length).toBe(1) // only the root WP is the spec/plan tier
      const root = groups[0]!
      expect(root.id).toBe(rootWp)
      expect(root.done).toBe(2)
      expect(root.active).toBe(3)
      expect(root.pct).toBe(67) // round(2/3*100) — SUM of leaves, NOT mean(100%, 100%, 0%)
    }
  })

  it("level 'lot' rolls up the nested-WP tier (the two sub-WPs)", () => {
    const { track, wpA, wpB } = build()
    const groups = statusByLevel(track.state(), 'lot', CONFIG).sort((a, b) => a.id.localeCompare(b.id))
    expect(groups.map((g) => g.id).sort()).toEqual([wpA, wpB].sort())
    const a = groups.find((g) => g.id === wpA)!
    expect(a).toMatchObject({ done: 1, active: 2, pct: 50 })
    const b = groups.find((g) => g.id === wpB)!
    expect(b).toMatchObject({ done: 1, active: 1, pct: 100 })
  })

  it('0/0 ⇒ n/a (a tier with only dropped leaves)', () => {
    const store = new EventStore(join(dir, 'x', '.track', 'events.jsonl'))
    const track = new Track(store, { now, newId: counter(), by: 'h', prov: { transport: 'cli', proposed: false, auth: 'local-user' } })
    const wp = track.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const leaf = track.createItem({ kind: 'feature', title: 'l', workspace: 'ws', parentId: wp })
    track.setRealization(leaf, 'cancelled') // DROPPED — excluded from denominator
    const groups = statusByLevel(track.state(), 'plan', CONFIG)
    expect(groups[0]).toMatchObject({ status: 'DROPPED', done: 0, active: 0, dropped: 1, pct: 'n/a' })
  })

  it('0/0 empty leaf-WP uses its own bucket instead of defaulting to DROPPED', () => {
    const store = new EventStore(join(dir, 'empty-wp', '.track', 'events.jsonl'))
    const track = new Track(store, { now, newId: counter(), by: 'h', prov: { transport: 'cli', proposed: false, auth: 'local-user' } })
    const wp = track.createItem({ kind: 'feature', title: 'Empty current WP', workspace: 'ws', role: 'workpackage' })
    const groups = statusByLevel(track.state(), 'plan', CONFIG)
    expect(groups[0]).toMatchObject({ id: wp, status: 'TO-DO', done: 0, active: 0, dropped: 0, pct: 'n/a' })
  })

  it("group rollup: AWAITED if any active descendant awaited, DROPPED if only dropped, DONE if all done", () => {
    const store = new EventStore(join(dir, 'y', '.track', 'events.jsonl'))
    const track = new Track(store, { now, newId: counter(), by: 'h', prov: { transport: 'cli', proposed: false, auth: 'local-user' } })
    const wp = track.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const a = track.createItem({ kind: 'feature', title: 'a', workspace: 'ws', parentId: wp })
    track.setRealization(a, 'in-progress')
    track.setRealization(a, 'done')
    const allDone = statusByLevel(track.state(), 'plan', CONFIG)[0]!
    expect(allDone.status).toBe('DONE')
    // add an awaited leaf (open blocker)
    const b = track.createItem({ kind: 'feature', title: 'b', workspace: 'ws', parentId: wp })
    const dec = track.createDecision({ decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [b], dossier: { context: '', options: [], qa: [] } })
    void dec
    const awaited = statusByLevel(track.state(), 'plan', CONFIG)[0]!
    expect(awaited.status).toBe('AWAITED')
  })
})
