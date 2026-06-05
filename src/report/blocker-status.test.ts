import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { Track } from '../track.js'
import { bucketOf } from './buckets.js'
import { effectiveBlockerOpen, effectiveOpenBlockersForItem } from './blocker-status.js'

let dir: string
let track: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-blkstatus-'))
  let n = 0
  track = new Track(new EventStore(join(dir, '.track', 'events.jsonl')), {
    by: 'tester',
    now: () => '2026-06-04T10:00:00.000Z',
    newId: () => `id-${String(++n).padStart(4, '0')}`,
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** R = a feature with one acceptance criterion + linked evidence; returns {R, evidenceId}. */
function refWithCriterion(): { R: string; ev: string } {
  const R = track.createItem({ kind: 'feature', title: 'R', workspace: 'ws' })
  const cr = track.addCriterion(R, 'R works')
  const ev = track.linkEvidence(cr, 'unit', 'R.test')
  return { R, ev }
}

const cfg = (baselineCommit: string) => ({ baselineCommit, requireAccepted: false })

describe('linked-accepted (v2.2a hybrid-A) — openBlocker no longer throws', () => {
  it('accepts a linked-accepted dependency blocker', () => {
    const { R } = refWithCriterion()
    const A = track.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    expect(() =>
      track.openBlocker({ targetId: A, kind: 'dependency', ref: R, reason: 'needs R accepted', resolutionRule: 'linked-accepted' }),
    ).not.toThrow()
  })
})

describe('linked-accepted — commit-relative, revocable openness', () => {
  let R: string, ev: string, A: string

  beforeEach(() => {
    ;({ R, ev } = refWithCriterion())
    A = track.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    track.openBlocker({ targetId: A, kind: 'dependency', ref: R, reason: 'needs R accepted', resolutionRule: 'linked-accepted' })
  })

  it('A is AWAITED while R is not yet accepted (unknown), then clears on pass', () => {
    expect(bucketOf(track.state(), track.state().items.get(A)!, cfg('c1'))).toBe('AWAITED')
    track.recordRun(ev, { commit: 'c1', env: 'ci', runner: 'v', result: 'pass' })
    expect(effectiveOpenBlockersForItem(track.state(), A, 'c1')).toHaveLength(0)
    expect(bucketOf(track.state(), track.state().items.get(A)!, cfg('c1'))).toBe('TO-DO')
  })

  it('a regression RE-OPENS the gate with NO new blocker event', () => {
    track.recordRun(ev, { commit: 'c1', env: 'ci', runner: 'v', result: 'pass' })
    const blockerCount = track.state().blockers.size
    expect(bucketOf(track.state(), track.state().items.get(A)!, cfg('c1'))).toBe('TO-DO')
    track.recordRun(ev, { commit: 'c1', env: 'ci', runner: 'v', result: 'fail' }) // R regresses at c1
    expect(track.state().blockers.size).toBe(blockerCount) // no new blocker
    expect(bucketOf(track.state(), track.state().items.get(A)!, cfg('c1'))).toBe('AWAITED')
  })

  it('strict pass-only: fail / unknown / stale / waived all HOLD the gate open', () => {
    const blocker = [...track.state().blockers.values()].find((b) => b.targetId === A)!
    // unknown (no run)
    expect(effectiveBlockerOpen(track.state(), blocker, 'c1')).toBe(true)
    // pass @ c1 → closed
    track.recordRun(ev, { commit: 'c1', env: 'ci', runner: 'v', result: 'pass' })
    expect(effectiveBlockerOpen(track.state(), blocker, 'c1')).toBe(false)
    // stale: ask at a different baseline than the run's commit
    expect(effectiveBlockerOpen(track.state(), blocker, 'c2')).toBe(true)
    // fail @ c1 → open
    track.recordRun(ev, { commit: 'c1', env: 'ci', runner: 'v', result: 'fail' })
    expect(effectiveBlockerOpen(track.state(), blocker, 'c1')).toBe(true)
  })

  it('waived HOLDS the gate (strict pass-only, owner policy P3)', () => {
    const cr = [...track.state().criteria.values()].find((c) => c.itemId === R)!
    track.waive(cr.id, 'accepted risk on R')
    const blocker = [...track.state().blockers.values()].find((b) => b.targetId === A)!
    expect(effectiveBlockerOpen(track.state(), blocker, 'c1')).toBe(true)
  })

  it('fold stays baseline-free: the fold scalar is conservatively open; the projection decides', () => {
    track.recordRun(ev, { commit: 'c1', env: 'ci', runner: 'v', result: 'pass' })
    const blocker = [...track.state().blockers.values()].find((b) => b.targetId === A)!
    expect(blocker.open).toBe(true) // fold cannot see acceptance → conservative open
    expect(effectiveBlockerOpen(track.state(), blocker, 'c1')).toBe(false) // projection: accepted
  })

  it('end-to-end through Track.report: AWAITED → not → AWAITED at the same baseline', () => {
    const awaited = (): string[] => track.report({ baselineCommit: 'c1' }).buckets.AWAITED.map((r) => r.id)
    expect(awaited()).toContain(A)
    track.recordRun(ev, { commit: 'c1', env: 'ci', runner: 'v', result: 'pass' })
    expect(awaited()).not.toContain(A)
    track.recordRun(ev, { commit: 'c1', env: 'ci', runner: 'v', result: 'fail' })
    expect(awaited()).toContain(A)
  })

  it('rejects manual resolve of a linked-accepted blocker (it auto-resolves only)', () => {
    const blocker = [...track.state().blockers.values()].find((b) => b.targetId === A)!
    expect(() => track.resolveBlocker(blocker.id)).toThrow()
  })

  it('a ref with zero criteria reads unknown → gate stays open', () => {
    const R2 = track.createItem({ kind: 'feature', title: 'R2', workspace: 'ws' })
    const A2 = track.createItem({ kind: 'feature', title: 'A2', workspace: 'ws' })
    track.openBlocker({ targetId: A2, kind: 'dependency', ref: R2, reason: 'x', resolutionRule: 'linked-accepted' })
    const b = [...track.state().blockers.values()].find((x) => x.targetId === A2)!
    expect(effectiveBlockerOpen(track.state(), b, 'c1')).toBe(true)
  })
})

describe('settle-once rules are unaffected by the projection', () => {
  it('linked-done still gates on ref realization (commit-agnostic)', () => {
    const dep = track.createItem({ kind: 'chore', title: 'dep', workspace: 'ws' })
    const A = track.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    track.openBlocker({ targetId: A, kind: 'dependency', ref: dep, reason: 'needs dep done' })
    // settle-once rules return the fold scalar — re-fetch the blocker from the CURRENT state.
    const isOpenNow = (): boolean => {
      const s = track.state()
      const b = [...s.blockers.values()].find((x) => x.targetId === A)!
      return effectiveBlockerOpen(s, b, 'anything')
    }
    expect(isOpenNow()).toBe(true)
    track.setRealization(dep, 'in-progress')
    track.setRealization(dep, 'done')
    expect(isOpenNow()).toBe(false)
  })
})
