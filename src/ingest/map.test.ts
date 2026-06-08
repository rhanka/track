import { describe, expect, it } from 'vitest'

import type { WorkEvent, WorkEventKind } from './contract.js'
import { IngestError, mapWorkEvent } from './map.js'

const ev = (kind: WorkEventKind, payload: Record<string, unknown>): WorkEvent => ({ v: 1, kind, payload })
const bad = (o: unknown): WorkEvent => o as WorkEvent // build a malformed envelope past the types

describe('mapWorkEvent — valid kinds → normalized {method, settles, args}', () => {
  const cases: ReadonlyArray<[string, WorkEvent, { method: string; settles: string; args: unknown[] }]> = [
    ['item.create', ev('item.create', { kind: 'feature', title: 'T', workspace: 'ws' }),
      { method: 'createItem', settles: 'never', args: [{ kind: 'feature', title: 'T', workspace: 'ws' }] }],
    ['item.create +optionals', ev('item.create', { kind: 'bug', title: 'T', workspace: 'ws', parentId: 'p', body: 'b', sourceKey: 'k' }),
      { method: 'createItem', settles: 'never', args: [{ kind: 'bug', title: 'T', workspace: 'ws', parentId: 'p', body: 'b', sourceKey: 'k' }] }],
    ['item.spec', ev('item.spec', { itemId: 'i', to: 'specified' }),
      { method: 'setSpec', settles: 'never', args: ['i', 'specified'] }],
    ['item.realize done ⇒ realize-terminal', ev('item.realize', { itemId: 'i', to: 'done' }),
      { method: 'setRealization', settles: 'realize-terminal', args: ['i', 'done'] }],
    ['decision.create', ev('decision.create', { decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: ['i'], dossier: { context: '', options: [], qa: [] } }),
      { method: 'createDecision', settles: 'never', args: [{ decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: ['i'], dossier: { context: '', options: [], qa: [] } }] }],
    ['decision.dossier', ev('decision.dossier', { decisionId: 'd', dossier: { context: 'x', options: [], qa: [] } }),
      { method: 'reviseDossier', settles: 'never', args: ['d', { context: 'x', options: [], qa: [] }] }],
    ['decision.outcome ⇒ always', ev('decision.outcome', { decisionId: 'd', to: 'go' }),
      { method: 'setOutcome', settles: 'always', args: ['d', 'go'] }],
    ['decision.disposition (reason absent ⇒ undefined arg)', ev('decision.disposition', { itemId: 'i', gate: 'orientation', disposition: 'skipped' }),
      { method: 'setDisposition', settles: 'never', args: ['i', 'orientation', 'skipped', undefined] }],
    ['acceptance.criterion', ev('acceptance.criterion', { itemId: 'i', statement: 's' }),
      { method: 'addCriterion', settles: 'never', args: ['i', 's'] }],
    ['acceptance.link', ev('acceptance.link', { criterionId: 'c', kind: 'unit', locator: 'l' }),
      { method: 'linkEvidence', settles: 'never', args: ['c', 'unit', 'l'] }],
    ['acceptance.run ⇒ evidence', ev('acceptance.run', { evidenceId: 'e', commit: 'c1', env: 'ci', runner: 'gh', result: 'pass' }),
      { method: 'recordRun', settles: 'evidence', args: ['e', { commit: 'c1', env: 'ci', runner: 'gh', result: 'pass' }] }],
    ['acceptance.waive ⇒ always', ev('acceptance.waive', { criterionId: 'c', reason: 'r' }),
      { method: 'waive', settles: 'always', args: ['c', 'r'] }],
    ['priority.assess', ev('priority.assess', { itemId: 'i', userBusinessValue: 1, timeCriticality: 2, riskReductionOpportunityEnablement: 3, jobSize: 4 }),
      { method: 'assessPriority', settles: 'never', args: ['i', { userBusinessValue: 1, timeCriticality: 2, riskReductionOpportunityEnablement: 3, jobSize: 4 }] }],
    ['blocker.raise (reason defaults to "")', ev('blocker.raise', { targetId: 't', kind: 'dependency', ref: 'r' }),
      { method: 'openBlocker', settles: 'never', args: [{ targetId: 't', kind: 'dependency', ref: 'r', reason: '' }] }],
    ['blocker.raise +rule +owner', ev('blocker.raise', { targetId: 't', kind: 'dependency', ref: 'r', reason: 'x', resolutionRule: 'manual', owner: 'human:a' }),
      { method: 'openBlocker', settles: 'never', args: [{ targetId: 't', kind: 'dependency', ref: 'r', reason: 'x', resolutionRule: 'manual', owner: 'human:a' }] }],
    ['blocker.resolve ⇒ always', ev('blocker.resolve', { blockerId: 'b' }),
      { method: 'resolveBlocker', settles: 'always', args: ['b'] }],
  ]

  it.each(cases)('%s', (_name, input, expected) => {
    const m = mapWorkEvent(input)
    expect(m.method).toBe(expected.method)
    expect(m.settles).toBe(expected.settles)
    expect(m.args).toEqual(expected.args)
  })

  it('covers every kind (no kind left unmapped)', () => {
    const covered = new Set(cases.map(([, e]) => e.kind))
    expect(covered.size).toBe(14)
  })
})

describe('mapWorkEvent — fail-closed rejections', () => {
  it('rejects an unknown contract major', () => {
    expect(() => mapWorkEvent(bad({ v: 2, kind: 'item.spec', payload: { itemId: 'i', to: 'specified' } }))).toThrow(
      /unsupported WorkEvent contract major/,
    )
  })
  it('rejects an unknown kind', () => {
    expect(() => mapWorkEvent(bad({ v: 1, kind: 'item.delete', payload: {} }))).toThrow(/unknown WorkEvent kind/)
  })
  it('rejects an unknown ENVELOPE key (no per-event actor/sponsor/proposed)', () => {
    expect(() => mapWorkEvent(bad({ v: 1, kind: 'item.spec', payload: { itemId: 'i', to: 'specified' }, actor: 'human:x' }))).toThrow(
      /unknown WorkEvent envelope key "actor"/,
    )
  })
  it('rejects a missing required field', () => {
    expect(() => mapWorkEvent(ev('item.create', { kind: 'feature', workspace: 'ws' }))).toThrow(/missing required field "title"/)
  })
  it('rejects an unknown payload field (never silently forwarded)', () => {
    expect(() => mapWorkEvent(ev('item.create', { kind: 'feature', title: 'T', workspace: 'ws', foo: 'x' }))).toThrow(
      /unknown payload field "foo"/,
    )
  })
  it('rejects a bad enum value', () => {
    expect(() => mapWorkEvent(ev('item.spec', { itemId: 'i', to: 'bogus' }))).toThrow(/must be one of/)
  })
  it('rejects a wrong-typed field', () => {
    expect(() =>
      mapWorkEvent(ev('priority.assess', { itemId: 'i', userBusinessValue: 'x', timeCriticality: 2, riskReductionOpportunityEnablement: 3, jobSize: 4 })),
    ).toThrow(/expected a finite number/)
  })
  it('rejects a non-object payload', () => {
    expect(() => mapWorkEvent(bad({ v: 1, kind: 'item.spec', payload: null }))).toThrow(/payload must be an object/)
  })
  it('rejects a non-string-array targets', () => {
    expect(() =>
      mapWorkEvent(ev('decision.create', { decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: 'i', dossier: {} })),
    ).toThrow(/expected a string\[\]/)
  })
})
