import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from './events/store.js'
import { validate } from './events/validate.js'
import type { Dossier } from './model/decision.js'
import { openBlockersForItem } from './state/fold.js'
import { Track } from './track.js'

let dir: string
let store: EventStore
let track: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-decision-'))
  store = new EventStore(join(dir, '.track', 'events.jsonl'))
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

function dossier(): Dossier {
  return { context: 'ctx', options: [], qa: [] }
}

function feature(title = 'f'): string {
  return track.createItem({ kind: 'feature', title, workspace: 'ws' })
}

describe('createDecision (A7)', () => {
  it('opens one decision blocker per target; targets are AWAITED, decision pending', () => {
    const t1 = feature('t1')
    const t2 = feature('t2')
    const d = track.createDecision({
      decisionKind: 'orientation',
      title: 'orient',
      workspace: 'ws',
      targets: [t1, t2],
      dossier: dossier(),
    })

    const state = track.state()
    const decBlockers = [...state.blockers.values()].filter((b) => b.kind === 'decision' && b.ref === d)
    expect(decBlockers).toHaveLength(2)
    expect(decBlockers.every((b) => b.open)).toBe(true)
    expect(openBlockersForItem(state, t1)).toHaveLength(1)
    expect(openBlockersForItem(state, t2)).toHaveLength(1)
    expect(state.decisions.get(d)!.outcome).toBe('pending')
    expect(validate(store.readAll()).ok).toBe(true)
  })

  it('rejects a decision targeting another decision (A3 recursion guard)', () => {
    const t = feature()
    const d1 = track.createDecision({
      decisionKind: 'orientation',
      title: 'd1',
      workspace: 'ws',
      targets: [t],
      dossier: dossier(),
    })
    expect(() =>
      track.createDecision({
        decisionKind: 'orientation',
        title: 'd2',
        workspace: 'ws',
        targets: [d1],
        dossier: dossier(),
      }),
    ).toThrow(/cannot target another decision/)
  })

  it('rejects duplicate target ids', () => {
    const t = feature()
    expect(() =>
      track.createDecision({
        decisionKind: 'orientation',
        title: 'x',
        workspace: 'ws',
        targets: [t, t],
        dossier: dossier(),
      }),
    ).toThrow(/same target twice/)
  })

  it('rejects an unknown target and an empty target list', () => {
    expect(() =>
      track.createDecision({
        decisionKind: 'orientation',
        title: 'x',
        workspace: 'ws',
        targets: ['nope'],
        dossier: dossier(),
      }),
    ).toThrow(/unknown target/)
    expect(() =>
      track.createDecision({
        decisionKind: 'orientation',
        title: 'x',
        workspace: 'ws',
        targets: [],
        dossier: dossier(),
      }),
    ).toThrow(/at least one target/)
  })
})

describe('outcome machine + target effect (A5, §2.6)', () => {
  it('deferred leaves the target AWAITED; a later go resolves it and auto-completes the gate', () => {
    const t = feature()
    const d = track.createDecision({
      decisionKind: 'orientation',
      title: 'orient',
      workspace: 'ws',
      targets: [t],
      dossier: dossier(),
    })

    track.setOutcome(d, 'deferred')
    let s = track.state()
    expect(s.decisions.get(d)!.outcome).toBe('deferred')
    expect(openBlockersForItem(s, t)).toHaveLength(1) // still AWAITED

    track.setOutcome(d, 'go') // deferred -> go is legal
    s = track.state()
    expect(s.decisions.get(d)!.outcome).toBe('go')
    expect(openBlockersForItem(s, t)).toHaveLength(0) // resolved
    expect(s.items.get(t)!.realization).toBe('to-do') // go does not drop
    expect(s.items.get(t)!.disposition.orientation).toBe('completed')
    expect(validate(store.readAll()).ok).toBe(true)
  })

  it('no-go resolves the blocker AND drops the target (rejected) as one atomic batch', () => {
    const t = feature()
    const d = track.createDecision({
      decisionKind: 'commitment',
      title: 'commit',
      workspace: 'ws',
      targets: [t],
      dossier: dossier(),
    })

    track.setOutcome(d, 'no-go')
    const s = track.state()
    expect(s.decisions.get(d)!.outcome).toBe('no-go')
    expect(openBlockersForItem(s, t)).toHaveLength(0)
    expect(s.items.get(t)!.realization).toBe('rejected')
    expect(s.items.get(t)!.disposition.commitment).toBe('completed')

    // the effect is ONE atomic cmdId batch (decision.outcome + blocker.resolved + realization.transition)
    const events = store.readAll()
    const outcomeEvent = events.find((e) => e.type === 'decision.outcome')!
    expect(outcomeEvent.cmdId).toBeDefined()
    const batch = events.filter((e) => e.cmdId === outcomeEvent.cmdId)
    expect(batch.map((e) => e.type).sort()).toEqual([
      'blocker.resolved',
      'decision.outcome',
      'realization.transition',
    ])
    expect(validate(events).ok).toBe(true)
  })

  it('flags a partial batch when a no-go member is dropped (A5 repair)', () => {
    const t = feature()
    const d = track.createDecision({
      decisionKind: 'commitment',
      title: 'commit',
      workspace: 'ws',
      targets: [t],
      dossier: dossier(),
    })
    track.setOutcome(d, 'no-go')

    const full = store.readAll()
    const partial = full.slice(0, -1) // drop the trailing batch member (realization.transition)
    const result = validate(partial)
    expect(result.findings.some((f) => f.kind === 'prev-hash')).toBe(false)
    expect(result.findings.some((f) => f.kind === 'partial-batch')).toBe(true)
  })

  it('rejects an outcome transition out of a terminal go/no-go', () => {
    const t = feature()
    const d = track.createDecision({
      decisionKind: 'orientation',
      title: 'orient',
      workspace: 'ws',
      targets: [t],
      dossier: dossier(),
    })
    track.setOutcome(d, 'go')
    expect(() => track.setOutcome(d, 'no-go')).toThrow(/illegal outcome transition go -> no-go/)
  })
})

describe('decision realization (prep) + dossier + disposition', () => {
  it('a decision is prepared (realization done) independently of being settled', () => {
    const t = feature()
    const d = track.createDecision({
      decisionKind: 'orientation',
      title: 'orient',
      workspace: 'ws',
      targets: [t],
      dossier: dossier(),
    })
    track.setRealization(d, 'in-progress')
    track.setRealization(d, 'done')
    const decision = track.state().decisions.get(d)!
    expect(decision.realization).toBe('done') // prepared
    expect(decision.outcome).toBe('pending') // but not settled
  })

  it('revises the dossier', () => {
    const t = feature()
    const d = track.createDecision({
      decisionKind: 'orientation',
      title: 'orient',
      workspace: 'ws',
      targets: [t],
      dossier: dossier(),
    })
    track.reviseDossier(d, { context: 'updated', options: [], qa: [] })
    expect(track.state().decisions.get(d)!.dossier.context).toBe('updated')
  })

  it('sets explicit dispositions and rejects explicit completed', () => {
    const t = feature()
    track.setDisposition(t, 'orientation', 'skipped')
    expect(track.state().items.get(t)!.disposition.orientation).toBe('skipped')
    expect(() => track.setDisposition(t, 'commitment', 'completed')).toThrow(/automatically/)
  })
})
