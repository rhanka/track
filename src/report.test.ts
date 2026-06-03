import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from './events/store.js'
import { formatReport } from './report/format.js'
import { Track } from './track.js'

let dir: string
let track: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-report-'))
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

function feature(title = 'f', workspace = 'ws'): string {
  return track.createItem({ kind: 'feature', title, workspace })
}

const emptyDossier = { context: '', options: [], qa: [] }
const base = { baselineCommit: 'c1' as const }

function ids(rows: { id: string }[]): string[] {
  return rows.map((r) => r.id)
}

describe('report buckets — A2 (SPEC §7)', () => {
  it('places items across all four buckets, decisions excluded by default', () => {
    const ref = feature('ref') // a TO-DO ref that keeps a dependency open
    const awaited = feature('awaited')
    track.setRealization(awaited, 'in-progress')
    track.openBlocker({ targetId: awaited, kind: 'dependency', ref, reason: 'needs ref' })

    const dropped = feature('dropped')
    const decision = track.createDecision({
      decisionKind: 'commitment',
      title: 'commit',
      workspace: 'ws',
      targets: [dropped],
      dossier: emptyDossier,
    })
    track.setOutcome(decision, 'no-go') // dropped -> rejected, decision blocker resolved

    const done = feature('done')
    track.setRealization(done, 'in-progress')
    track.setRealization(done, 'done')

    const todo = feature('todo')

    const report = track.report(base)
    expect(ids(report.buckets.AWAITED)).toContain(awaited)
    expect(ids(report.buckets.DROPPED)).toContain(dropped)
    expect(ids(report.buckets.DONE)).toContain(done)
    expect(ids(report.buckets['TO-DO'])).toContain(todo)

    // decisions are not in the item buckets and absent without --decisions
    const everyRow = Object.values(report.buckets).flat()
    expect(ids(everyRow)).not.toContain(decision)
    expect(report.decisions).toBeUndefined()
  })

  it('AWAITED wins over DONE (precedence): a done item with an open blocker is AWAITED', () => {
    const ref = feature('ref')
    const item = feature('done-but-blocked')
    track.setRealization(item, 'in-progress')
    track.setRealization(item, 'done')
    track.openBlocker({ targetId: item, kind: 'dependency', ref, reason: 'late dep' })

    const report = track.report(base)
    expect(ids(report.buckets.AWAITED)).toContain(item)
    expect(ids(report.buckets.DONE)).not.toContain(item)
  })

  it('requireAccepted demotes a done-but-not-accepted item out of DONE', () => {
    const item = feature('done-unaccepted') // no criteria ⇒ acceptance unknown
    track.setRealization(item, 'in-progress')
    track.setRealization(item, 'done')

    expect(ids(track.report({ ...base, requireAccepted: false }).buckets.DONE)).toContain(item)

    const strict = track.report({ ...base, requireAccepted: true })
    expect(ids(strict.buckets.DONE)).not.toContain(item)
    expect(ids(strict.buckets['TO-DO'])).toContain(item)
  })
})

describe('decision view + priority sort', () => {
  it('--decisions lists decisions by realization + outcome', () => {
    const t = feature()
    const d = track.createDecision({
      decisionKind: 'orientation',
      title: 'orient',
      workspace: 'ws',
      targets: [t],
      dossier: emptyDossier,
    })
    const report = track.report({ ...base, decisions: true })
    const row = report.decisions!.find((x) => x.id === d)!
    expect(row.outcome).toBe('pending')
    expect(row.decisionKind).toBe('orientation')
  })

  it('sorts a bucket by the active priority scheme (higher score first)', () => {
    const low = feature('low')
    track.assessPriority(low, { userBusinessValue: 1, timeCriticality: 0, riskReductionOpportunityEnablement: 0, jobSize: 1 })
    const high = feature('high')
    track.assessPriority(high, { userBusinessValue: 9, timeCriticality: 0, riskReductionOpportunityEnablement: 0, jobSize: 1 })

    const todo = ids(track.report(base).buckets['TO-DO'])
    expect(todo.indexOf(high)).toBeLessThan(todo.indexOf(low))
  })
})

describe('query (SPEC §6)', () => {
  it('filters by kind / workspace', () => {
    const bug = track.createItem({ kind: 'bug', title: 'b', workspace: 'ws1' })
    const feat = track.createItem({ kind: 'feature', title: 'f', workspace: 'ws2' })
    expect(ids(track.query({ kind: 'bug' }, base))).toEqual([bug])
    expect(ids(track.query({ workspace: 'ws2' }, base))).toEqual([feat])
  })

  it('filters by bucket and realization', () => {
    const inProgress = feature('a')
    track.setRealization(inProgress, 'in-progress')
    feature('b')
    expect(ids(track.query({ realization: 'in-progress' }, base))).toEqual([inProgress])
  })
})

describe('formatting', () => {
  it('renders json / text / md', () => {
    feature('My Title')
    const report = track.report(base)
    expect(formatReport(report, 'json')).toContain('"buckets"')
    const text = formatReport(report, 'text')
    expect(text).toContain('TO-DO (1)')
    expect(text).toContain('My Title')
    const md = formatReport(report, 'md')
    expect(md).toContain('## TO-DO')
    expect(md).toContain('**My Title**')
  })

  it('sanitizes user titles: no newline/heading injection, md metacharacters escaped', () => {
    track.createItem({ kind: 'feature', title: 'evil\n## INJECTED *x*', workspace: 'ws' })
    const text = formatReport(track.report(base), 'text')
    expect(text.split('\n').some((l) => l.startsWith('## INJECTED'))).toBe(false)
    const md = formatReport(track.report(base), 'md')
    expect(md.split('\n').some((l) => l.startsWith('## INJECTED'))).toBe(false)
    expect(md).toContain('\\*x\\*') // markdown metacharacters escaped
  })
})
