import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acceptanceStatus, criterionStatus } from './accept/status.js'
import { EventStore } from './events/store.js'
import { Track } from './track.js'

let dir: string
let track: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-accept-'))
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

function run(result: 'pass' | 'fail', commit = 'c1') {
  return { commit, env: 'ci', runner: 'vitest', result }
}

describe('acceptanceStatus cascade (SPEC §2.4)', () => {
  it('zero criteria ⇒ unknown', () => {
    const i = feature()
    expect(acceptanceStatus(track.state(), i, 'c1')).toBe('unknown')
  })

  it('a criterion with no evidence ⇒ unknown', () => {
    const i = feature()
    track.addCriterion(i, 'must work')
    expect(acceptanceStatus(track.state(), i, 'c1')).toBe('unknown')
  })

  it('all evidence pass at baseline ⇒ pass', () => {
    const i = feature()
    const c = track.addCriterion(i, 'works')
    const e = track.linkEvidence(c, 'unit', 't1')
    track.recordRun(e, run('pass'))
    expect(acceptanceStatus(track.state(), i, 'c1')).toBe('pass')
  })

  it('a run at a different commit ⇒ stale', () => {
    const i = feature()
    const c = track.addCriterion(i, 'works')
    const e = track.linkEvidence(c, 'unit', 't1')
    track.recordRun(e, run('pass', 'old-commit'))
    expect(acceptanceStatus(track.state(), i, 'c1')).toBe('stale')
  })

  it('aggregates: one unknown among passes ⇒ unknown', () => {
    const i = feature()
    const c1 = track.addCriterion(i, 'a')
    const e = track.linkEvidence(c1, 'unit', 't1')
    track.recordRun(e, run('pass'))
    track.addCriterion(i, 'b') // no evidence ⇒ unknown
    expect(acceptanceStatus(track.state(), i, 'c1')).toBe('unknown')
  })
})

describe('criterionStatus — A6 (fail overrides waiver) + multi-evidence', () => {
  it('a live fail overrides a prior waiver (A6)', () => {
    const i = feature()
    const c = track.addCriterion(i, 'x')
    track.waive(c, 'temporary exception')
    expect(criterionStatus(track.state(), c, 'c1')).toBe('waived')

    const e = track.linkEvidence(c, 'unit', 't1')
    track.recordRun(e, run('fail'))
    expect(criterionStatus(track.state(), c, 'c1')).toBe('fail')
  })

  it('multi-evidence: all-pass ⇒ pass; one regressing fail ⇒ fail (revocable)', () => {
    const i = feature()
    const c = track.addCriterion(i, 'x')
    const e1 = track.linkEvidence(c, 'unit', 't1')
    const e2 = track.linkEvidence(c, 'e2e', 't2')
    track.recordRun(e1, run('pass'))
    track.recordRun(e2, run('pass'))
    expect(criterionStatus(track.state(), c, 'c1')).toBe('pass')

    track.recordRun(e2, run('fail')) // regress one evidence
    expect(criterionStatus(track.state(), c, 'c1')).toBe('fail')
  })

  it('a waiver passes a criterion with no evidence', () => {
    const i = feature()
    const c = track.addCriterion(i, 'x')
    track.waive(c, 'accepted exception')
    expect(criterionStatus(track.state(), c, 'c1')).toBe('waived')
    expect(acceptanceStatus(track.state(), i, 'c1')).toBe('waived')
  })
})

describe('A3 — no acceptance criterion on a Decision', () => {
  it('rejects addCriterion on a decision', () => {
    const t = feature()
    const d = track.createDecision({
      decisionKind: 'orientation',
      title: 'x',
      workspace: 'ws',
      targets: [t],
      dossier: { context: '', options: [], qa: [] },
    })
    expect(() => track.addCriterion(d, 'x')).toThrow(/cannot add an acceptance criterion to a decision/)
  })
})

describe('accept run --from ingestion', () => {
  it('ingests a JUnit report, matching evidence by locator (skips failures/unknowns)', () => {
    const i = feature()
    const c = track.addCriterion(i, 'x')
    track.linkEvidence(c, 'unit', 'com.foo.Bar#test1')
    const junit = `<testsuite>
      <testcase name="com.foo.Bar#test1"/>
      <testcase name="unmatched"><failure message="boom"/></testcase>
      <testcase name="skipped-one"><skipped/></testcase>
    </testsuite>`
    const count = track.ingestRuns(junit, 'junit', { commit: 'c1', env: 'ci', runner: 'junit' })
    expect(count).toBe(1) // only the matching evidence
    expect(acceptanceStatus(track.state(), i, 'c1')).toBe('pass')
  })

  it('ingests a JSON report with a failing result', () => {
    const i = feature()
    const c = track.addCriterion(i, 'x')
    track.linkEvidence(c, 'unit', 'loc1')
    const json = JSON.stringify({ results: [{ locator: 'loc1', result: 'fail' }] })
    track.ingestRuns(json, 'json', { commit: 'c1', env: 'ci', runner: 'jest' })
    expect(criterionStatus(track.state(), c, 'c1')).toBe('fail')
  })

  it('does NOT record a skipped/unknown JSON status as a pass', () => {
    const i = feature()
    const c = track.addCriterion(i, 'x')
    track.linkEvidence(c, 'unit', 'loc1')
    const json = JSON.stringify({ results: [{ locator: 'loc1', status: 'skipped' }] })
    expect(track.ingestRuns(json, 'json', { commit: 'c1', env: 'ci', runner: 'jest' })).toBe(0)
    expect(criterionStatus(track.state(), c, 'c1')).toBe('unknown')
  })

  it('records a run for ALL evidence sharing a locator', () => {
    const c1 = track.addCriterion(feature(), 'a')
    track.linkEvidence(c1, 'unit', 'shared')
    const c2 = track.addCriterion(feature(), 'b')
    track.linkEvidence(c2, 'unit', 'shared')
    const json = JSON.stringify({ results: [{ locator: 'shared', result: 'pass' }] })
    expect(track.ingestRuns(json, 'json', { commit: 'c1', env: 'ci', runner: 'jest' })).toBe(2)
    expect(criterionStatus(track.state(), c1, 'c1')).toBe('pass')
    expect(criterionStatus(track.state(), c2, 'c1')).toBe('pass')
  })

  it('JUnit: XML-like text inside CDATA is not misread as a failure', () => {
    const i = feature()
    const c = track.addCriterion(i, 'x')
    track.linkEvidence(c, 'unit', 'loc')
    const junit = `<testsuite><testcase name="loc"><system-out><![CDATA[log: <failure> in output]]></system-out></testcase></testsuite>`
    track.ingestRuns(junit, 'junit', { commit: 'c1', env: 'ci', runner: 'junit' })
    expect(criterionStatus(track.state(), c, 'c1')).toBe('pass')
  })

  it('acceptanceStatus is n/a for a decision', () => {
    const t = feature()
    const d = track.createDecision({
      decisionKind: 'orientation',
      title: 'x',
      workspace: 'ws',
      targets: [t],
      dossier: { context: '', options: [], qa: [] },
    })
    expect(acceptanceStatus(track.state(), d, 'c1')).toBe('n/a')
  })
})
