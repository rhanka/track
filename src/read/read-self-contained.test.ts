// RED→GREEN guard: the versioned `@sentropic/track/read` subpath must be SELF-CONTAINED. A consumer
// (Focus-M1 L2) binds against `/read` ALONE — every type NAMED in the public shape of a `/read`-exported
// interface must be importable FROM `/read`, without reaching into the unversioned main barrel's `export *`
// library surface. This test imports each referenced model/foundational type FROM './index.js' and USES it
// in a TYPE position, so a missing re-export fails `tsc` (the real gate for additive type re-exports).

import { describe, expect, it } from 'vitest'
import {
  READ_CONTRACT_VERSION,
  type AmendmentStep,
  type CanevasView,
  type DecisionDossierView,
} from './index.js'
// The transitive closure under test — referenced by `/read` interfaces but NOT previously re-exported:
//   from ../model/decision.js — Dossier (DecisionDossierView.dossier), Outcome (DecisionDossierView.outcome),
//     Option/QAEntry/DossierArtifact (Dossier.{options,qa,artifacts}), ComprehensionEvidence (DossierArtifact)
//   from ../model/priority.js — PriorityAssessment (Dossier.decisionEvaluation)
//   from ../model/item.js     — ItemId (DecisionDossierView.id, CanevasOptions.decisionId, StalledItem.id, …)
//   from ../events/types.js   — ActorId (AmendmentStep.by), EventType (AmendmentStep.kind),
//     Provenance (AmendmentProv.auth = Provenance['auth']), Sha256 (Cursor.head, Freshness, BranchProvenance)
import type {
  ActorId,
  ComprehensionEvidence,
  Dossier,
  DossierArtifact,
  EventType,
  ItemId,
  Option,
  Outcome,
  PriorityAssessment,
  Provenance,
  QAEntry,
  Sha256,
  WorkEventKind,
} from './index.js'

describe('@sentropic/track/read is self-contained (Focus-M1 L2 versioned binding)', () => {
  it('re-exports every model/foundational type named in a /read interface public shape', () => {
    // USE each imported type in a type position so a MISSING export fails the typecheck gate.
    const itemId: ItemId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const actorId: ActorId = 'agent:focus-m1'
    const eventType: EventType = 'decision.outcome'
    const sha: Sha256 = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const provAuth: Provenance['auth'] = 'signed'
    const outcome: Outcome = 'go'
    const affordance: WorkEventKind = 'demand.raise'

    const option: Option = { id: 'A', title: 'Option A', summary: 'do A' }
    const qa: QAEntry = { id: 'q1', question: 'why?' }
    const comprehension: ComprehensionEvidence = { subject: actorId, dossierHash: 'sha256:abc' }
    const artifact: DossierArtifact = {
      kind: 'h2a-decision-dossier',
      negotiationRef: 'neg-1',
      dossierHash: 'sha256:def',
      comprehension: [comprehension],
    }
    const priority: PriorityAssessment = {
      itemId,
      schemeId: 'wsjf',
      schemeVersion: 1,
      inputs: { jobSize: 1 },
      score: 1,
      at: '2026-06-21T00:00:00.000Z',
    }
    const dossier: Dossier = {
      context: 'ctx',
      options: [option],
      qa: [qa],
      decisionEvaluation: priority,
      artifacts: [artifact],
    }

    // The /read interfaces these foundational types feed — assembled here to bind the whole shape locally.
    const view: DecisionDossierView = {
      id: itemId,
      title: 'D1',
      workspace: 'ws',
      outcome,
      dossier,
    }
    const step: AmendmentStep = {
      seq: 1,
      at: '2026-06-21T00:00:00.000Z',
      by: actorId,
      kind: eventType,
      prov: { proposed: true, auth: provAuth },
      origin: 'machine',
    }
    const canevas: CanevasView = {
      workspace: 'ws',
      report: { buckets: { AWAITED: [], DROPPED: [], DONE: [], 'TO-DO': [] } },
      prov: {},
      affordances: {},
      dossier: view,
    }

    expect(sha.startsWith('sha256:')).toBe(true)
    expect(view.id).toBe(itemId)
    expect(step.kind).toBe('decision.outcome')
    expect(canevas.dossier?.outcome).toBe('go')
    expect(affordance).toBe('demand.raise')
  })

  it('pins READ_CONTRACT_VERSION at 1.13.0 (+Objective Loop refs — additive)', () => {
    expect(READ_CONTRACT_VERSION).toBe('1.13.0')
  })
})
