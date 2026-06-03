import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from './events/store.js'
import type { PriorityAssessment, WsjfInputs } from './model/priority.js'
import { Track } from './track.js'

let dir: string
let track: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-priority-'))
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

function feature(): string {
  return track.createItem({ kind: 'feature', title: 'f', workspace: 'ws' })
}

function wsjf(over: Partial<WsjfInputs> = {}): WsjfInputs {
  return {
    userBusinessValue: 1,
    timeCriticality: 1,
    riskReductionOpportunityEnablement: 1,
    jobSize: 1,
    ...over,
  }
}

describe('WSJF prioritization (SPEC §2.8)', () => {
  it('computes (UBV + TC + RR/OE) / jobSize', () => {
    const i = feature()
    const a = track.assessPriority(
      i,
      wsjf({ userBusinessValue: 8, timeCriticality: 4, riskReductionOpportunityEnablement: 2, jobSize: 2 }),
    )
    expect(a.score).toBe(7) // (8+4+2)/2
    expect(track.state().items.get(i)!.priority!.score).toBe(7)
  })

  it('rejects a non-positive jobSize', () => {
    const i = feature()
    expect(() => track.assessPriority(i, wsjf({ jobSize: 0 }))).toThrow(/jobSize must be > 0/)
  })

  it('orders items by live priority score (desc)', () => {
    const low = feature()
    const high = feature()
    track.assessPriority(low, wsjf({ userBusinessValue: 2, jobSize: 2 })) // (2+1+1)/2 = 2
    track.assessPriority(high, wsjf({ userBusinessValue: 8, jobSize: 1 })) // (8+1+1)/1 = 10

    const ordered = [...track.state().items.values()]
      .filter((it) => it.priority !== undefined)
      .sort((a, b) => b.priority!.score - a.priority!.score)
      .map((it) => it.id)
    expect(ordered).toEqual([high, low])
  })

  it('the latest assessment is live; a frozen dossier snapshot does not change', () => {
    const i = feature()
    const frozen = track.assessPriority(i, wsjf({ userBusinessValue: 3, jobSize: 2 })) // 2.5
    // freeze that assessment into a decision dossier (decisionEvaluation)
    const d = track.createDecision({
      decisionKind: 'commitment',
      title: 'commit',
      workspace: 'ws',
      targets: [i],
      dossier: { context: '', options: [], qa: [], decisionEvaluation: frozen },
    })
    // re-assess (live changes)
    track.assessPriority(i, wsjf({ userBusinessValue: 9, jobSize: 1 })) // 11

    const state = track.state()
    expect(state.items.get(i)!.priority!.score).toBe(11) // live updated
    const snapshot = state.decisions.get(d)!.dossier.decisionEvaluation as PriorityAssessment
    expect(snapshot.score).toBe(2.5) // frozen snapshot unchanged
  })
})
