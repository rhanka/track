import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { Track } from '../track.js'
import { TrackReader } from './contract.js'

// `workspaceActivity` is PURE over the folded log: track holds no clock, so the caller injects
// `now` (and an optional `idleMs`). These tests mint events at controlled `at` timestamps by
// re-pointing a `Track` with a different `now` at the SAME store, then poll the reader at a fixed
// `now`. Default `idleMs` = 24h ⇒ "stalled" means DURABLY stuck.

const NOW = '2026-06-08T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const DAY = 86_400_000
const OLD = new Date(NOW_MS - 2 * DAY).toISOString() // 2 days back — well past the 24h default
const FRESH = new Date(NOW_MS - 60_000).toISOString() // 1 min back — inside the window
const BASE = { baselineCommit: 'HEAD', now: NOW }

let dir: string
let eventsPath: string
let reader: TrackReader
let seq = 0

/** A Track whose every emitted event is stamped `at = when` (the injected clock). */
function trackAt(when: string): Track {
  return new Track(new EventStore(eventsPath), {
    by: 'tester',
    now: () => when,
    newId: () => `id-${String(++seq).padStart(4, '0')}`,
  })
}

beforeEach(() => {
  seq = 0
  dir = mkdtempSync(join(tmpdir(), 'track-wsact-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  reader = new TrackReader(eventsPath)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('workspaceActivity — pending count', () => {
  it('counts TO-DO + AWAITED only (never DONE / DROPPED)', () => {
    const t = trackAt(FRESH)
    const todo = t.createItem({ kind: 'chore', title: 'todo', workspace: 'W' }) // TO-DO
    const dep = t.createItem({ kind: 'chore', title: 'dep', workspace: 'W' }) // TO-DO too
    const awaited = t.createItem({ kind: 'feature', title: 'awaited', workspace: 'W' })
    t.openBlocker({ targetId: awaited, kind: 'dependency', ref: dep, reason: 'needs dep' }) // AWAITED

    const done = t.createItem({ kind: 'chore', title: 'done', workspace: 'W' })
    t.setRealization(done, 'in-progress')
    t.setRealization(done, 'done') // DONE — excluded

    const dropped = t.createItem({ kind: 'chore', title: 'dropped', workspace: 'W' })
    t.setRealization(dropped, 'cancelled') // DROPPED — excluded

    void todo
    // pending = todo + dep + awaited = 3 (done + dropped excluded), with the concrete rows surfaced too.
    const act = reader.workspaceActivity('W', BASE)
    expect(act.pending).toBe(3)
    expect(act.pendingItems.map((p) => [p.title, p.bucket])).toEqual([
      ['todo', 'TO-DO'],
      ['dep', 'TO-DO'],
      ['awaited', 'AWAITED'],
    ])
  })

  it('is workspace-scoped: W excludes V items', () => {
    const t = trackAt(FRESH)
    t.createItem({ kind: 'chore', title: 'w1', workspace: 'W' })
    t.createItem({ kind: 'chore', title: 'w2', workspace: 'W' })
    t.createItem({ kind: 'chore', title: 'v1', workspace: 'V' })
    const w = reader.workspaceActivity('W', BASE)
    const v = reader.workspaceActivity('V', BASE)
    expect(w.pending).toBe(2)
    expect(w.pendingItems.map((p) => p.title)).toEqual(['w1', 'w2'])
    expect(v.pending).toBe(1)
    expect(v.pendingItems.map((p) => p.title)).toEqual(['v1'])
  })
})

describe('workspaceActivity — stalled predicates (older than idleMs triggers; fresh does not)', () => {
  it('(1) awaited-open-blocker: stalled when the blocker openedAt is old, not when fresh', () => {
    // OLD blocker → stalled
    let t = trackAt(OLD)
    const ti = t.createItem({ kind: 'feature', title: 'tgt', workspace: 'W' })
    const dep = t.createItem({ kind: 'chore', title: 'dep', workspace: 'W' })
    t.openBlocker({ targetId: ti, kind: 'dependency', ref: dep, reason: 'wait', resolutionRule: 'manual' })
    let act = reader.workspaceActivity('W', BASE)
    const s = act.stalled.find((x) => x.id === ti)!
    expect(s).toMatchObject({ reason: 'awaited-open-blocker', since: OLD })

    // FRESH blocker on a separate target → not stalled
    t = trackAt(FRESH)
    const ti2 = t.createItem({ kind: 'feature', title: 'tgt2', workspace: 'W' })
    const dep2 = t.createItem({ kind: 'chore', title: 'dep2', workspace: 'W' })
    t.openBlocker({ targetId: ti2, kind: 'dependency', ref: dep2, reason: 'wait', resolutionRule: 'manual' })
    act = reader.workspaceActivity('W', BASE)
    expect(act.stalled.find((x) => x.id === ti2)).toBeUndefined()
  })

  it('(2) pending-decision: stalled when the latest event is old, not when fresh', () => {
    // OLD pending decision → stalled
    let t = trackAt(OLD)
    const item = t.createItem({ kind: 'feature', title: 'subject', workspace: 'W' })
    const dOld = t.createDecision({
      decisionKind: 'commitment',
      title: 'd-old',
      workspace: 'W',
      targets: [item],
      dossier: { context: 'c', options: [], qa: [] },
    })
    let act = reader.workspaceActivity('W', BASE)
    expect(act.stalled.find((x) => x.id === dOld)).toMatchObject({ reason: 'pending-decision', since: OLD })

    // FRESH pending decision → not stalled
    t = trackAt(FRESH)
    const item2 = t.createItem({ kind: 'feature', title: 'subject2', workspace: 'W' })
    const dFresh = t.createDecision({
      decisionKind: 'commitment',
      title: 'd-fresh',
      workspace: 'W',
      targets: [item2],
      dossier: { context: 'c', options: [], qa: [] },
    })
    act = reader.workspaceActivity('W', BASE)
    expect(act.stalled.find((x) => x.id === dFresh)).toBeUndefined()
  })

  it('(2) pending-decision: deferred counts too; a settled (go) decision does not', () => {
    const t = trackAt(OLD)
    const i1 = t.createItem({ kind: 'feature', title: 'i1', workspace: 'W' })
    const deferred = t.createDecision({
      decisionKind: 'commitment',
      title: 'deferred',
      workspace: 'W',
      targets: [i1],
      dossier: { context: 'c', options: [], qa: [] },
    })
    t.setOutcome(deferred, 'deferred')

    const i2 = t.createItem({ kind: 'feature', title: 'i2', workspace: 'W' })
    const settled = t.createDecision({
      decisionKind: 'commitment',
      title: 'settled',
      workspace: 'W',
      targets: [i2],
      dossier: { context: 'c', options: [], qa: [] },
    })
    t.setOutcome(settled, 'go')

    const act = reader.workspaceActivity('W', BASE)
    expect(act.stalled.find((x) => x.id === deferred)?.reason).toBe('pending-decision')
    expect(act.stalled.find((x) => x.id === settled)).toBeUndefined()
  })

  it('(3) in-progress-idle: stalled when no event since the window; a FRESH in-progress item is not stalled', () => {
    // in-progress, last touched OLD → stalled
    const t = trackAt(OLD)
    const idle = t.createItem({ kind: 'feature', title: 'idle', workspace: 'W' })
    t.setRealization(idle, 'in-progress')
    let act = reader.workspaceActivity('W', BASE)
    expect(act.stalled.find((x) => x.id === idle)).toMatchObject({ reason: 'in-progress-idle', since: OLD })

    // a FRESH transition on the SAME aggregate clears staleness (latest event is recent)
    trackAt(FRESH).setRealization(idle, 'done') // now DONE — no longer in-progress and recent anyway
    act = reader.workspaceActivity('W', BASE)
    expect(act.stalled.find((x) => x.id === idle)).toBeUndefined()
  })

  it('(3) a fresh in-progress item (recent transition) is NOT stalled', () => {
    const t = trackAt(OLD)
    const wip = t.createItem({ kind: 'feature', title: 'wip', workspace: 'W' }) // created OLD
    trackAt(FRESH).setRealization(wip, 'in-progress') // but moved in-progress recently
    const act = reader.workspaceActivity('W', BASE)
    expect(act.stalled.find((x) => x.id === wip)).toBeUndefined()
  })

  it('(4) todo-idle: stalled when creation is old, not when fresh', () => {
    trackAt(OLD).createItem({ kind: 'chore', title: 'old-todo', workspace: 'W' })
    trackAt(FRESH).createItem({ kind: 'chore', title: 'fresh-todo', workspace: 'W' })
    const act = reader.workspaceActivity('W', BASE)
    const oldOne = act.stalled.find((x) => x.title === 'old-todo')
    expect(oldOne).toMatchObject({ reason: 'todo-idle', since: OLD })
    expect(act.stalled.find((x) => x.title === 'fresh-todo')).toBeUndefined()
  })

  it('respects a caller-supplied idleMs (1h): a 2h-old todo is stalled, a 30min-old one is not', () => {
    trackAt(new Date(NOW_MS - 2 * 3_600_000).toISOString()).createItem({ kind: 'chore', title: 'two-h', workspace: 'W' })
    trackAt(new Date(NOW_MS - 30 * 60_000).toISOString()).createItem({ kind: 'chore', title: 'half-h', workspace: 'W' })
    const act = reader.workspaceActivity('W', { ...BASE, idleMs: 3_600_000 })
    expect(act.stalled.find((x) => x.title === 'two-h')?.reason).toBe('todo-idle')
    expect(act.stalled.find((x) => x.title === 'half-h')).toBeUndefined()
  })
})

describe('workspaceActivity — latestEventAt + isolation', () => {
  it('latestEventAt is the workspace max event.at', () => {
    trackAt(OLD).createItem({ kind: 'chore', title: 'a', workspace: 'W' })
    const t = trackAt(FRESH)
    const b = t.createItem({ kind: 'chore', title: 'b', workspace: 'W' })
    void b
    // a V-workspace event at a LATER time must not bleed into W's latestEventAt
    trackAt('2026-06-08T11:59:59.000Z').createItem({ kind: 'chore', title: 'v', workspace: 'V' })
    const act = reader.workspaceActivity('W', BASE)
    expect(act.latestEventAt).toBe(FRESH)
  })

  it('latestEventAt is undefined for a workspace with no events', () => {
    trackAt(FRESH).createItem({ kind: 'chore', title: 'a', workspace: 'W' })
    expect(reader.workspaceActivity('EMPTY', BASE).latestEventAt).toBeUndefined()
  })

  it('full isolation: W activity excludes V stalled items', () => {
    // V has an old todo (stalled in V) — must not appear in W
    trackAt(OLD).createItem({ kind: 'chore', title: 'v-old', workspace: 'V' })
    trackAt(FRESH).createItem({ kind: 'chore', title: 'w-fresh', workspace: 'W' })
    const w = reader.workspaceActivity('W', BASE)
    expect(w.workspace).toBe('W')
    expect(w.stalled).toEqual([])
    const v = reader.workspaceActivity('V', BASE)
    expect(v.stalled.map((s) => s.title)).toEqual(['v-old'])
  })
})
