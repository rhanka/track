import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { readHead } from '../events/head.js'
import { Track } from '../track.js'
import { fold } from '../state/fold.js'
import { auditFindings } from '../report/audit.js'
import { applyRestructurePlan, assertTokenClosure, computePlanHash, type RestructureEdge, type RestructurePlan } from './restructure-apply.js'
import { runCli, type CliIO } from './index.js'
import type { TrackEvent } from '../events/types.js'

// Lot 1/R5 — the migration apply verb. A ratified plan {itemId→parentId} is applied via restructureReparent
// (append-only, clientToken = f(planHash,itemId) ⇒ replay is a no-op via the dedup store). planHash
// content-addresses the COMPLETE map. baseline {streamLength,lastContentHash} is MANDATORY (anti-TOCTOU) for
// any real write; a full DRY-RUN of every edge runs BEFORE the first append (atomicity). Post-apply GATE:
// (a) intention per edge, (b) closure (EXACTLY the plan edges, exact tokens), (c) zero out-of-plan orphan.

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

/** The store head, as the mandatory baseline anchor a ratified plan must pin. */
function baselineOf(): { streamLength: number; lastContentHash: string | null } {
  return {
    streamLength: new EventStore(eventsPath).readAll().length,
    lastContentHash: readHead(eventsPath)?.lastContentHash ?? null,
  }
}

beforeEach(() => {
  seq = 0
  dir = mkdtempSync(join(tmpdir(), 'track-apply-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('applyRestructurePlan — happy path + intention/closure', () => {
  it('moves each edge child under its target (cross-workspace) and passes the gates', () => {
    const t = trackAt()
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    const edges = [{ itemId: child, parentId: wpW }]
    const plan: RestructurePlan = { edges, planHash: computePlanHash(edges), baseline: baselineOf() }

    const res = applyRestructurePlan(eventsPath, plan)
    expect(res.applied).toBe(1)
    expect(res.edges).toBe(1)

    const state = fold(new EventStore(eventsPath).readAll())
    expect(state.items.get(child)!.parentId).toBe(wpW) // INTENTION: folded parent === plan target
    expect(state.items.get(child)!.workspace).toBe('V') // workspace immutable

    // CLOSURE: exactly one item.reparented carrying this plan's EXACT namespaced clientToken.
    const tokened = new EventStore(eventsPath)
      .readAll()
      .filter((e) => e.type === 'item.reparented' && e.clientToken === `${plan.planHash}:${child}`)
    expect(tokened.length).toBe(1)
    expect(tokened[0]!.payload).toMatchObject({ parentId: wpW, planHash: plan.planHash })
  })

  it('applies a TWO-edge plan (both moved) and the strict closure passes', () => {
    const t = trackAt()
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const c1 = t.createItem({ kind: 'chore', title: 'l1', workspace: 'V' })
    const c2 = t.createItem({ kind: 'chore', title: 'l2', workspace: 'U' })
    const edges = [
      { itemId: c1, parentId: wpW },
      { itemId: c2, parentId: wpW },
    ]
    const res = applyRestructurePlan(eventsPath, { edges, planHash: computePlanHash(edges), baseline: baselineOf() })
    expect(res.applied).toBe(2)
    const st = fold(new EventStore(eventsPath).readAll())
    expect(st.items.get(c1)!.parentId).toBe(wpW)
    expect(st.items.get(c2)!.parentId).toBe(wpW)
  })

  it('is IDEMPOTENT — a re-apply with the same planHash is a no-op (dedup store), gates still pass', () => {
    const t = trackAt()
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    const edges = [{ itemId: child, parentId: wpW }]
    const plan: RestructurePlan = { edges, planHash: computePlanHash(edges), baseline: baselineOf() }

    const first = applyRestructurePlan(eventsPath, plan)
    expect(first.applied).toBe(1)
    const countAfterFirst = new EventStore(eventsPath).readAll().length

    const second = applyRestructurePlan(eventsPath, plan) // allApplied ⇒ baseline skipped, replay no-op
    expect(second.applied).toBe(0) // replay wrote nothing
    expect(second.alreadyApplied).toBe(1)
    expect(new EventStore(eventsPath).readAll().length).toBe(countAfterFirst) // no new events
    expect(fold(new EventStore(eventsPath).readAll()).items.get(child)!.parentId).toBe(wpW)
  })

  it('a re-PLAN (different edge map ⇒ different planHash ⇒ different tokens) is NOT falsely skipped', () => {
    const t = trackAt()
    const wp1 = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'W', role: 'workpackage' })
    const wp2 = t.createItem({ kind: 'chore', title: 'WP2', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    const planA: RestructurePlan = { edges: [{ itemId: child, parentId: wp1 }], baseline: baselineOf() }
    planA.planHash = computePlanHash(planA.edges)
    applyRestructurePlan(eventsPath, planA)
    expect(fold(new EventStore(eventsPath).readAll()).items.get(child)!.parentId).toBe(wp1)

    // baseline recomputed AGAINST the moved store (planA's event landed).
    const planB: RestructurePlan = { edges: [{ itemId: child, parentId: wp2 }], baseline: baselineOf() }
    planB.planHash = computePlanHash(planB.edges)
    expect(planB.planHash).not.toBe(planA.planHash)
    const res = applyRestructurePlan(eventsPath, planB)
    expect(res.applied).toBe(1) // a different plan is a real new move, not a dedup skip
    expect(fold(new EventStore(eventsPath).readAll()).items.get(child)!.parentId).toBe(wp2)
  })
})

describe('applyRestructurePlan — fail-closed gates', () => {
  it('REJECTS a declared planHash that does not content-address the edge map (mismatch)', () => {
    const t = trackAt()
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    const before = new EventStore(eventsPath).readAll().length
    const plan: RestructurePlan = { edges: [{ itemId: child, parentId: wpW }], planHash: 'sha256:deadbeef' }
    expect(() => applyRestructurePlan(eventsPath, plan)).toThrow(/planHash/i)
    expect(new EventStore(eventsPath).readAll().length).toBe(before) // nothing written
  })

  it('REJECTS a write with NO baseline (mandatory anti-TOCTOU precondition)', () => {
    const t = trackAt()
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    const before = new EventStore(eventsPath).readAll().length
    const edges = [{ itemId: child, parentId: wpW }]
    expect(() => applyRestructurePlan(eventsPath, { edges, planHash: computePlanHash(edges) })).toThrow(/baseline/i)
    expect(new EventStore(eventsPath).readAll().length).toBe(before) // nothing written
  })

  it('ATOMIC: a multi-edge plan whose edges would form a CYCLE writes NOTHING (full pre-flight)', () => {
    const t = trackAt()
    const x = t.createItem({ kind: 'chore', title: 'X', workspace: 'W', role: 'workpackage' })
    const y = t.createItem({ kind: 'chore', title: 'Y', workspace: 'W', role: 'workpackage' })
    const before = new EventStore(eventsPath).readAll().length
    const edges = [
      { itemId: x, parentId: y },
      { itemId: y, parentId: x },
    ] // X→Y then Y→X — neither edge sees the loop alone; the cumulative graph does.
    const plan: RestructurePlan = { edges, planHash: computePlanHash(edges), baseline: baselineOf() }
    expect(() => applyRestructurePlan(eventsPath, plan)).toThrow(/cycle/i)
    // The dry-run rejects BEFORE any append — not even the first edge lands (the old edge-by-edge path would).
    expect(new EventStore(eventsPath).readAll().length).toBe(before)
  })

  it('REJECTS when a pre-existing out-of-plan orphan would remain (orphan GATE)', () => {
    const t = trackAt()
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    // an out-of-plan orphan in W (W has a WP ⇒ a parentless open item is an orphan)
    t.createItem({ kind: 'chore', title: 'orphan', workspace: 'W' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    const edges = [{ itemId: child, parentId: wpW }]
    const plan: RestructurePlan = { edges, planHash: computePlanHash(edges), baseline: baselineOf() }
    // The apply leaves an orphan the plan never claimed ⇒ the orphan gate fails fail-closed.
    expect(() => applyRestructurePlan(eventsPath, plan)).toThrow(/orphan/i)
  })

  it('REJECTS a no-baseline plan even when targets ALREADY hold via a DIFFERENT plan (token-based replay, not parent coincidence)', () => {
    const t = trackAt()
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    const other = t.createItem({ kind: 'chore', title: 'leaf2', workspace: 'V' })
    // P1 (2 edges) homes child under wpW — its planHash/tokens differ from P2 below.
    const p1 = [{ itemId: child, parentId: wpW }, { itemId: other, parentId: wpW }]
    applyRestructurePlan(eventsPath, { edges: p1, planHash: computePlanHash(p1), baseline: baselineOf() })
    expect(fold(new EventStore(eventsPath).readAll()).items.get(child)!.parentId).toBe(wpW) // parent coincides now

    // P2 (1 edge, same target) — DIFFERENT planHash ⇒ its exact token is NOT in the log ⇒ a real write ⇒
    // baseline stays MANDATORY. The old parent-coincidence `allApplied` would have skipped it.
    const before = new EventStore(eventsPath).readAll().length
    const p2 = [{ itemId: child, parentId: wpW }]
    expect(() => applyRestructurePlan(eventsPath, { edges: p2, planHash: computePlanHash(p2) })).toThrow(/baseline/i)
    expect(new EventStore(eventsPath).readAll().length).toBe(before) // nothing written
  })

  it('REJECTS a stale baseline (the store changed since the plan was computed)', () => {
    const t = trackAt()
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    const edges = [{ itemId: child, parentId: wpW }]
    const plan: RestructurePlan = {
      edges,
      planHash: computePlanHash(edges),
      baseline: { streamLength: 999, lastContentHash: 'sha256:stale' },
    }
    expect(() => applyRestructurePlan(eventsPath, plan)).toThrow(/baseline|precondition|stale/i)
  })
})

describe('post-apply audit — the moved child is no longer an orphan', () => {
  it('a restructure that re-homes an orphan removes the orphan finding', () => {
    const t = trackAt()
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    // an orphan in W, IN the plan ⇒ re-homing it under wpW resolves it.
    const orphan = t.createItem({ kind: 'chore', title: 'orphan', workspace: 'W' })
    expect(auditFindings(t.state()).filter((f) => f.kind === 'orphan').length).toBe(1)
    const edges = [{ itemId: orphan, parentId: wpW }]
    applyRestructurePlan(eventsPath, { edges, planHash: computePlanHash(edges), baseline: baselineOf() })
    const after = fold(new EventStore(eventsPath).readAll())
    expect(auditFindings(after).filter((f) => f.kind === 'orphan')).toEqual([])
  })
})

describe('track restructure apply — CLI verb', () => {
  function io(): { io: CliIO; out: string[] } {
    const out: string[] = []
    return { io: { cwd: dir, out: (s) => out.push(s), err: (s) => out.push(s) }, out }
  }
  it('applies a ratified plan file end-to-end and moves the child cross-workspace', () => {
    const t = trackAt()
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    const edges = [{ itemId: child, parentId: wpW }]
    const planFile = join(dir, 'plan.json')
    writeFileSync(planFile, JSON.stringify({ edges, planHash: computePlanHash(edges), baseline: baselineOf() }))

    const { io: cio, out } = io()
    const code = runCli(['restructure', 'apply', '--plan', planFile], cio) as number
    expect(code).toBe(0)
    expect(out.join('')).toMatch(/appl/i)
    expect(fold(new EventStore(eventsPath).readAll()).items.get(child)!.parentId).toBe(wpW)
  })
})

describe('assertTokenClosure — airtight closure (defense-in-depth, directly testable)', () => {
  const edges: RestructureEdge[] = [
    { itemId: 'A', parentId: 'P' },
    { itemId: 'B', parentId: 'P' },
  ]
  const ev = (aggregateId: string, clientToken: string, parentId: string, planHash: string): TrackEvent =>
    ({ type: 'item.reparented', aggregateId, clientToken, payload: { parentId, planHash } }) as unknown as TrackEvent

  it('accepts exactly-tokened, correctly-targeted events', () => {
    const after = [ev('A', 'H:A', 'P', 'H'), ev('B', 'H:B', 'P', 'H')]
    expect(() => assertTokenClosure(after, edges, 'H')).not.toThrow()
  })
  it('REJECTS a token carried on the WRONG aggregate (swap) — even if both ids stay in-plan and parents match', () => {
    const after = [ev('A', 'H:B', 'P', 'H'), ev('B', 'H:A', 'P', 'H')] // tokens swapped
    expect(() => assertTokenClosure(after, edges, 'H')).toThrow(/closure|swap/i)
  })
  it('REJECTS a reparent to the wrong parent', () => {
    const after = [ev('A', 'H:A', 'WRONG', 'H'), ev('B', 'H:B', 'P', 'H')]
    expect(() => assertTokenClosure(after, edges, 'H')).toThrow(/closure/i)
  })
  it('REJECTS a foreign planHash stamp', () => {
    const after = [ev('A', 'H:A', 'P', 'OTHER'), ev('B', 'H:B', 'P', 'H')]
    expect(() => assertTokenClosure(after, edges, 'H')).toThrow(/closure/i)
  })
  it('REJECTS a missing edge (count mismatch)', () => {
    const after = [ev('A', 'H:A', 'P', 'H')] // B never reparented
    expect(() => assertTokenClosure(after, edges, 'H')).toThrow(/closure/i)
  })
})
