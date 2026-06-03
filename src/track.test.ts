import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from './events/store.js'
import { Track } from './track.js'

let dir: string
let track: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-facade-'))
  const store = new EventStore(join(dir, '.track', 'events.jsonl'))
  let n = 0
  track = new Track(store, {
    by: 'tester',
    now: () => '2026-06-03T10:00:00.000Z',
    newId: () => `id-${String(++n).padStart(4, '0')}`,
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function newItem(over: Partial<{ title: string; workspace: string }> = {}): string {
  return track.createItem({
    kind: 'feature',
    title: over.title ?? 'a feature',
    workspace: over.workspace ?? 'ws',
  })
}

describe('Track — item creation', () => {
  it('creates a non-decision item at to-specify / to-do', () => {
    const id = newItem()
    const item = track.state().items.get(id)!
    expect(item.specStatus).toBe('to-specify')
    expect(item.realization).toBe('to-do')
    expect(item.kind).toBe('feature')
  })

  it('creates a decision item with spec axis n/a', () => {
    const id = track.createItem({ kind: 'decision', title: 'orient', workspace: 'ws' })
    expect(track.state().items.get(id)!.specStatus).toBe('n/a')
  })
})

describe('Track — specification axis (A3 partial)', () => {
  it('allows to-specify -> specified once', () => {
    const id = newItem()
    track.setSpec(id, 'specified')
    expect(track.state().items.get(id)!.specStatus).toBe('specified')
  })

  it('rejects the reverse spec transition', () => {
    const id = newItem()
    track.setSpec(id, 'specified')
    expect(() => track.setSpec(id, 'to-specify')).toThrow(/illegal spec transition/)
  })

  it('rejects a spec transition on a decision (n/a axis)', () => {
    const id = track.createItem({ kind: 'decision', title: 'orient', workspace: 'ws' })
    expect(() => track.setSpec(id, 'specified')).toThrow(/n\/a/)
  })
})

describe('Track — realization axis (A3 partial)', () => {
  it('allows to-do -> in-progress -> done', () => {
    const id = newItem()
    track.setRealization(id, 'in-progress')
    track.setRealization(id, 'done')
    expect(track.state().items.get(id)!.realization).toBe('done')
  })

  it('rejects skipping to-do -> done', () => {
    const id = newItem()
    expect(() => track.setRealization(id, 'done')).toThrow(/illegal realization transition/)
  })

  it('rejects any transition out of a terminal done', () => {
    const id = newItem()
    track.setRealization(id, 'in-progress')
    track.setRealization(id, 'done')
    expect(() => track.setRealization(id, 'in-progress')).toThrow(/illegal realization transition/)
  })

  it('allows cancelled from to-do and from in-progress', () => {
    const a = newItem()
    track.setRealization(a, 'cancelled')
    expect(track.state().items.get(a)!.realization).toBe('cancelled')

    const b = newItem()
    track.setRealization(b, 'in-progress')
    track.setRealization(b, 'cancelled')
    expect(track.state().items.get(b)!.realization).toBe('cancelled')
  })

  it('rejects a manual transition to rejected (requires a decision cause)', () => {
    const id = newItem()
    expect(() => track.setRealization(id, 'rejected')).toThrow(/requires a decision cause/)
  })

  it('allows rejected from in-progress with a decision cause', () => {
    const id = newItem()
    track.setRealization(id, 'in-progress')
    track.setRealization(id, 'rejected', { decisionId: 'dec-1' })
    expect(track.state().items.get(id)!.realization).toBe('rejected')
  })

  it('throws on an unknown item', () => {
    expect(() => track.setRealization('nope', 'in-progress')).toThrow(/unknown item/)
  })
})

describe('Track — blockers (SPEC §2.9)', () => {
  it('computes the open-blocker set', () => {
    const target = newItem()
    const ref = newItem()
    track.openBlocker({ targetId: target, kind: 'dependency', ref, reason: 'needs ref' })

    const state = track.state()
    const open = [...state.blockers.values()].filter((b) => b.open)
    expect(open).toHaveLength(1)
    expect(open[0]!.targetId).toBe(target)
  })

  it('auto-resolves a linked-done dependency when the ref item is done', () => {
    const target = newItem()
    const ref = newItem()
    const blockerId = track.openBlocker({ targetId: target, kind: 'dependency', ref, reason: 'dep' })

    expect(track.state().blockers.get(blockerId)!.open).toBe(true)

    track.setRealization(ref, 'in-progress')
    track.setRealization(ref, 'done')

    expect(track.state().blockers.get(blockerId)!.open).toBe(false)
  })

  it('allows manual resolve only for a manual dependency blocker', () => {
    const target = newItem()
    const ref = newItem()
    const blockerId = track.openBlocker({
      targetId: target,
      kind: 'dependency',
      ref,
      reason: 'dep',
      resolutionRule: 'manual',
    })
    track.resolveBlocker(blockerId)
    expect(track.state().blockers.get(blockerId)!.open).toBe(false)
  })

  it('rejects manual resolve of a linked-done dependency blocker', () => {
    const target = newItem()
    const ref = newItem()
    const blockerId = track.openBlocker({ targetId: target, kind: 'dependency', ref, reason: 'dep' })
    expect(() => track.resolveBlocker(blockerId)).toThrow(/cannot manually resolve a 'linked-done'/)
  })

  it('rejects manual resolve of a decision blocker', () => {
    const target = newItem()
    const decision = track.createItem({ kind: 'decision', title: 'go?', workspace: 'ws' })
    const blockerId = track.openBlocker({
      targetId: target,
      kind: 'decision',
      ref: decision,
      reason: 'awaiting decision',
    })
    expect(() => track.resolveBlocker(blockerId)).toThrow(/cannot manually resolve a decision blocker/)
  })
})
