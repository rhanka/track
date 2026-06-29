import { describe, expect, it } from 'vitest'

import { WORK_EVENT_KINDS } from './contract.js'
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
    ['acceptance.link (evidenceId absent ⇒ undefined arg ⇒ server-mint)', ev('acceptance.link', { criterionId: 'c', kind: 'unit', locator: 'l' }),
      { method: 'linkEvidence', settles: 'never', args: ['c', 'unit', 'l', undefined] }],
    ['acceptance.link (caller-supplied deterministic evidenceId, M2=B)', ev('acceptance.link', { criterionId: 'c', kind: 'unit', locator: 'l', evidenceId: 'ev-det' }),
      { method: 'linkEvidence', settles: 'never', args: ['c', 'unit', 'l', 'ev-det'] }],
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
    ['scope.verification ⇒ evidence (payload passthrough)', ev('scope.verification', { runId: 'vr', runner: 'stp', commit: 'c1', verdict: 'clean' }),
      { method: 'recordVerification', settles: 'evidence', args: [{ runId: 'vr', runner: 'stp', commit: 'c1', verdict: 'clean' }] }],
    // The five kinds the cases above omitted — added so the coverage gate below truly covers EVERY kind.
    ['item.reparent (parentId absent ⇒ detach to root)', ev('item.reparent', { itemId: 'i' }),
      { method: 'reparentItem', settles: 'always', args: ['i', undefined] }],
    ['decision.add-artifact ⇒ always', ev('decision.add-artifact', { decisionId: 'd', artifact: { kind: 'note', text: 'x' } }),
      { method: 'addDecisionArtifact', settles: 'always', args: ['d', { kind: 'note', text: 'x' }] }],
    ['blocker.resolve-external ⇒ always (workspace pin supplied by ingest, not the event)', ev('blocker.resolve-external', { engagementRef: 'eng-1' }),
      { method: 'resolveExternalDependency', settles: 'always', args: ['eng-1'] }],
    ['scope.declare ⇒ always (scope shape re-asserted in the facade)', ev('scope.declare', { itemId: 'i', scope: { allowed: ['src/**'] } }),
      { method: 'declareScope', settles: 'always', args: ['i', { allowed: ['src/**'] }] }],
    // WP-codes A1 (DESIGN) — the additive durable display-code kind (1.5.0).
    ['item.assign-code ⇒ always (role-container + non-empty + roster-global uniqueness re-asserted in the facade)', ev('item.assign-code', { itemId: 'i', code: 'WP1' }),
      { method: 'assignCode', settles: 'always', args: ['i', 'WP1'] }],
    ['item.spec-amend ⇒ always (payload passthrough; patch verbatim)', ev('item.spec-amend', { itemId: 'i', baseHash: 'h0', patch: [{ op: 'add', path: '/a', value: 1 }], resultHash: 'h1' }),
      { method: 'amendSpec', settles: 'always', args: ['i', { itemId: 'i', baseHash: 'h0', patch: [{ op: 'add', path: '/a', value: 1 }], resultHash: 'h1' }] }],
    // Acceptance-freshness lifecycle — the two additive kinds (item.anchor, item.consolidate).
    ['item.anchor ⇒ evidence (reason absent ⇒ undefined)', ev('item.anchor', { itemId: 'i', commit: 'sha-A' }),
      { method: 'anchorRealization', settles: 'evidence', args: ['i', 'sha-A', undefined] }],
    ['item.anchor +reason', ev('item.anchor', { itemId: 'i', commit: 'sha-A', reason: 'consolidate' }),
      { method: 'anchorRealization', settles: 'evidence', args: ['i', 'sha-A', 'consolidate'] }],
    ['item.consolidate ⇒ always (caller-authoritative items)', ev('item.consolidate', { items: ['i1', 'i2'], mergeCommit: 'merge-sha' }),
      { method: 'consolidate', settles: 'always', args: [['i1', 'i2'], 'merge-sha'] }],
    // Demand lifecycle (Mode A) — the six additive kinds (1.3.0).
    ['demand.raise ⇒ never (payload passthrough; shape re-asserted in the facade)', ev('demand.raise', { type: 'feature', raw: { text: 'x' }, source: { kind: 'human' }, workspace: 'ws', handler: 'h' }),
      { method: 'raiseDemand', settles: 'never', args: [{ type: 'feature', raw: { text: 'x' }, source: { kind: 'human' }, workspace: 'ws', handler: 'h' }] }],
    ['demand.claim ⇒ always (handler optional)', ev('demand.claim', { demandId: 'd', handler: 'h' }),
      { method: 'claimDemand', settles: 'always', args: ['d', { handler: 'h' }] }],
    ['demand.agree ⇒ always (atomic promotion; items object[])', ev('demand.agree', { demandId: 'd', handler: 'h', items: [{ title: 'T' }] }),
      { method: 'agreeDemand', settles: 'always', args: ['d', { items: [{ title: 'T' }], handler: 'h' }] }],
    ['demand.disposition ⇒ always (duplicateOf containment re-asserted in the facade)', ev('demand.disposition', { demandId: 'd', outcome: 'rejected', reason: 'no', handler: 'h' }),
      { method: 'disposeDemand', settles: 'always', args: ['d', { outcome: 'rejected', reason: 'no', handler: 'h' }] }],
    ['spec.claim ⇒ always (durable WHO-is-attempting fact)', ev('spec.claim', { itemId: 'i', handler: 'h' }),
      { method: 'startSpec', settles: 'always', args: ['i', { handler: 'h' }] }],
    ['spec.abandon ⇒ always (durable explicit-abandon fact)', ev('spec.abandon', { itemId: 'i', handler: 'h', reason: 'ctx out' }),
      { method: 'abandonSpec', settles: 'always', args: ['i', { reason: 'ctx out', handler: 'h' }] }],
    // Cross-workspace WP reorg (DESIGN R2) — the default-denied capability kind (1.4.0).
    ['item.restructure ⇒ always (cross-workspace move; planHash authorization scope)', ev('item.restructure', { itemId: 'i', parentId: 'p', planHash: 'h' }),
      { method: 'restructureReparent', settles: 'always', args: ['i', 'p', 'h', undefined] }],
  ]

  it.each(cases)('%s', (_name, input, expected) => {
    const m = mapWorkEvent(input)
    expect(m.method).toBe(expected.method)
    expect(m.settles).toBe(expected.settles)
    expect(m.args).toEqual(expected.args)
  })

  it('covers every kind (no kind left unmapped)', () => {
    // A REAL coverage gate: the cases must exercise EVERY WorkEventKind. Derived from WORK_EVENT_KINDS so a
    // newly-added kind that has no mapper case fails here (the old `=== 15` falsely claimed full coverage
    // while WORK_EVENT_KINDS held 20 — 5 kinds were unmapped).
    const covered = new Set(cases.map(([, e]) => e.kind))
    expect(covered.size).toBe(WORK_EVENT_KINDS.length)
    const missing = WORK_EVENT_KINDS.filter((k) => !covered.has(k))
    expect(missing).toEqual([])
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
  it('accepts and threads a clientToken envelope key (v2.3c)', () => {
    const m = mapWorkEvent({ v: 1, kind: 'item.spec', payload: { itemId: 'i', to: 'specified' }, clientToken: 'tok-1' })
    expect(m.clientToken).toBe('tok-1')
  })
  it('rejects an empty or oversized clientToken', () => {
    expect(() => mapWorkEvent(bad({ v: 1, kind: 'item.spec', payload: { itemId: 'i', to: 'specified' }, clientToken: '' }))).toThrow(/clientToken/)
    expect(() => mapWorkEvent(bad({ v: 1, kind: 'item.spec', payload: { itemId: 'i', to: 'specified' }, clientToken: 'x'.repeat(257) }))).toThrow(/clientToken/)
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
