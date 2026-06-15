import { describe, expect, it } from 'vitest'

import { INGEST_CONTRACT_VERSION, WORK_EVENT_KINDS, WORK_EVENT_SCHEMA } from './contract.js'

// A breaking change to the WorkEvent contract surface (a renamed/removed kind, method, settles class, or
// required field) MUST fail here — this is the contract's snapshot gate (v2.3b-DESIGN.md §6/§7).
describe('WorkEvent contract surface', () => {
  it('pins the contract version and the kind list', () => {
    expect(INGEST_CONTRACT_VERSION).toBe('1.1.0') // seam v0 FREEZE — MINOR bump (additive optional fields)
    expect([...WORK_EVENT_KINDS]).toEqual([
      'item.create',
      'item.reparent',
      'item.spec',
      'item.realize',
      'decision.create',
      'decision.dossier',
      'decision.add-artifact',
      'decision.outcome',
      'decision.disposition',
      'acceptance.criterion',
      'acceptance.link',
      'acceptance.run',
      'acceptance.waive',
      'priority.assess',
      'blocker.raise',
      'blocker.resolve',
      'blocker.resolve-external',
      'scope.verification',
      'scope.declare',
      'item.spec-amend',
    ])
  })

  it('pins method + settles + required fields per kind', () => {
    const surface = Object.fromEntries(
      WORK_EVENT_KINDS.map((k) => {
        const s = WORK_EVENT_SCHEMA[k]
        const required = Object.entries(s.fields)
          .filter(([, f]) => f.required)
          .map(([n]) => n)
          .sort()
        return [k, { method: s.method, settles: s.settles, required }]
      }),
    )
    expect(surface).toEqual({
      'item.create': { method: 'createItem', settles: 'never', required: ['kind', 'title', 'workspace'] },
      'item.reparent': { method: 'reparentItem', settles: 'always', required: ['itemId'] },
      'item.spec': { method: 'setSpec', settles: 'never', required: ['itemId', 'to'] },
      'item.realize': { method: 'setRealization', settles: 'realize-terminal', required: ['itemId', 'to'] },
      'decision.create': {
        method: 'createDecision',
        settles: 'never',
        required: ['decisionKind', 'dossier', 'targets', 'title', 'workspace'],
      },
      'decision.dossier': { method: 'reviseDossier', settles: 'never', required: ['decisionId', 'dossier'] },
      'decision.add-artifact': { method: 'addDecisionArtifact', settles: 'always', required: ['artifact', 'decisionId'] },
      'decision.outcome': { method: 'setOutcome', settles: 'always', required: ['decisionId', 'to'] },
      'decision.disposition': {
        method: 'setDisposition',
        settles: 'never',
        required: ['disposition', 'gate', 'itemId'],
      },
      'acceptance.criterion': { method: 'addCriterion', settles: 'never', required: ['itemId', 'statement'] },
      'acceptance.link': {
        method: 'linkEvidence',
        settles: 'never',
        required: ['criterionId', 'kind', 'locator'],
      },
      'acceptance.run': {
        method: 'recordRun',
        settles: 'evidence',
        required: ['commit', 'env', 'evidenceId', 'result', 'runner'],
      },
      'acceptance.waive': { method: 'waive', settles: 'always', required: ['criterionId', 'reason'] },
      'priority.assess': {
        method: 'assessPriority',
        settles: 'never',
        required: ['itemId', 'jobSize', 'riskReductionOpportunityEnablement', 'timeCriticality', 'userBusinessValue'],
      },
      'blocker.raise': { method: 'openBlocker', settles: 'never', required: ['kind', 'targetId'] },
      'blocker.resolve': { method: 'resolveBlocker', settles: 'always', required: ['blockerId'] },
      'blocker.resolve-external': { method: 'resolveExternalDependency', settles: 'always', required: ['engagementRef'] },
      'scope.verification': { method: 'recordVerification', settles: 'evidence', required: ['commit', 'runId', 'runner', 'verdict'] },
      'scope.declare': { method: 'declareScope', settles: 'always', required: ['itemId', 'scope'] },
      'item.spec-amend': { method: 'amendSpec', settles: 'always', required: ['baseHash', 'itemId', 'patch', 'resultHash'] },
    })
  })
})
