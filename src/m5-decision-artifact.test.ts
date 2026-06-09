// M5 (decision-presentation) — `Dossier.artifacts[]` + the append-only `decision.add-artifact` kind.
// Record-only pointer to an h2a decision dossier (M5-decision-presentation-DESIGN.md §3, §7).
// Track RECORDS evidence; it NEVER verifies an attestation or recomputes a rank.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { computeHash } from './events/canonical.js'
import { readHead } from './events/head.js'
import { EventStore } from './events/store.js'
import type { Provenance } from './events/types.js'
import { validate } from './events/validate.js'
import type { WorkEvent, WorkEventKind } from './ingest/contract.js'
import { ingest, type IngestContext } from './ingest/ingest.js'
import { IngestError } from './ingest/map.js'
import type { DossierArtifact } from './model/decision.js'
import { TrackReader } from './read/contract.js'
import { Track } from './track.js'

// A signed bridge attestation — the channel principal is the BRIDGE that relayed the write.
const BRIDGE_SIGNED: Provenance = {
  transport: 'http',
  proposed: false,
  auth: 'signed',
  principal: 'h2a:bridge:relay-1', // the RELAYER (channel), NOT the attester
  sig: { alg: 'Ed25519', value: 'YnJpZGdl', by: 'bridge-key' },
}
const LOCAL: Provenance = { transport: 'cli', proposed: false, auth: 'local-user' }
const UNAUTH: Provenance = { transport: 'import', proposed: false, auth: 'unauthenticated' }

const ev = (kind: WorkEventKind, payload: Record<string, unknown>, clientToken?: string): WorkEvent => ({
  v: 1,
  kind,
  payload,
  ...(clientToken !== undefined ? { clientToken } : {}),
})

const DOSSIER_ARTIFACT: DossierArtifact = {
  kind: 'h2a-decision-dossier',
  negotiationRef: 'neg-42',
  dossierHash: 'sha256:abc',
  comprehension: [
    {
      subject: 'human:decider', // the ATTESTER = the decider (payload, distinct from prov.principal)
      dossierHash: 'sha256:abc',
      h2aEventRef: 'journal#7',
      attestationHash: 'sha256:att',
      sig: { alg: 'Ed25519', value: 'ZGVjaWRlcg', by: 'decider-key' },
      at: '2026-06-08T00:00:00.000Z',
    },
  ],
  label: 'risk-ranked dossier',
}

let dir: string
let eventsPath: string
let store: EventStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-m5-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  store = new EventStore(eventsPath)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const integral = (): boolean => validate(store.readAll(), readHead(eventsPath)).ok
const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({ by: 'h2a:bridge:relay-1', workspace: 'ws', prov: BRIDGE_SIGNED, ...over })

/** Create one item + one decision in workspace `ws` via a signed channel; return the decisionId. */
function seedDecision(c: IngestContext = ctx()): string {
  const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: c.workspace })], c, store).ids[0]!
  return ingest(
    [ev('decision.create', { decisionKind: 'orientation', title: 'D', workspace: c.workspace, targets: [itemId], dossier: { context: '', options: [], qa: [] } })],
    c,
    store,
  ).ids[0]!
}

describe('M5 — additivity (frozen-contract regression)', () => {
  it('a decision.created with NO artifacts hashes byte-identically to a pre-M5 dossier event', () => {
    const dossier = { context: 'c', options: [], qa: [] }
    // The contentHash is computed over the command core (see frame.ts). The dossier payload object is
    // identical whether or not `artifacts` exists as an OPTIONAL key — canonicalize drops `undefined`.
    const withoutKey = computeHash(dossier)
    const withUndefinedKey = computeHash({ ...dossier, artifacts: undefined })
    expect(withUndefinedKey).toBe(withoutKey) // adding the optional field never changes the bytes
  })

  it('an existing dossier.revised event with no artifacts stays integral', () => {
    const decId = seedDecision()
    ingest([ev('decision.dossier', { decisionId: decId, dossier: { context: 'updated', options: [], qa: [] } })], ctx(), store)
    expect(integral()).toBe(true)
    const revised = store.readAll().find((e) => e.type === 'dossier.revised')!
    expect('artifacts' in (revised.payload as { dossier: Record<string, unknown> }).dossier).toBe(false)
  })
})

describe('M5 — confused-deputy (the load-bearing fix, both reviewers)', () => {
  it('records the attester subject DISTINCT from the event prov.principal (the bridge); no verification', () => {
    const decId = seedDecision()
    ingest([ev('decision.add-artifact', { decisionId: decId, artifact: DOSSIER_ARTIFACT })], ctx(), store)
    const e = store.readAll().find((x) => x.type === 'decision.artifact-added')!
    // The channel principal is the BRIDGE (relayer)...
    expect((e.prov as Provenance).principal).toBe('h2a:bridge:relay-1')
    // ...but the recorded attester (payload) is the DECIDER — never conflated.
    const artifact = (e.payload as { artifact: DossierArtifact }).artifact
    if (artifact.kind !== 'h2a-decision-dossier') throw new Error('expected h2a-decision-dossier')
    expect(artifact.comprehension![0]!.subject).toBe('human:decider')
    expect(artifact.comprehension![0]!.subject).not.toBe((e.prov as Provenance).principal)
    // Track does NO verification — the log is simply integral (it recorded the evidence verbatim).
    expect(integral()).toBe(true)
    expect(validate(store.readAll(), readHead(eventsPath)).ok).toBe(true)
  })

  it('folds the artifact onto the decision dossier (append, existing dossier untouched)', () => {
    const decId = seedDecision()
    ingest([ev('decision.add-artifact', { decisionId: decId, artifact: DOSSIER_ARTIFACT })], ctx(), store)
    const track = new Track(store)
    const dossier = track.state().decisions.get(decId)!.dossier
    expect(dossier.context).toBe('') // the original dossier fields are untouched
    expect(dossier.artifacts).toEqual([DOSSIER_ARTIFACT])
  })

  it('appends a SECOND artifact (no whole-dossier rewrite, both kept in order)', () => {
    const decId = seedDecision()
    const view: DossierArtifact = { kind: 'rendered-view', viewRef: 'view://1', sourceDossierHash: 'sha256:abc', label: 'card' }
    ingest([ev('decision.add-artifact', { decisionId: decId, artifact: DOSSIER_ARTIFACT })], ctx(), store)
    ingest([ev('decision.add-artifact', { decisionId: decId, artifact: view })], ctx(), store)
    const dossier = new Track(store).state().decisions.get(decId)!.dossier
    expect(dossier.artifacts).toEqual([DOSSIER_ARTIFACT, view])
  })
})

describe('M5 — discriminated-union completeness (fail-closed)', () => {
  it('rejects an h2a-decision-dossier with no dossierHash', () => {
    const decId = seedDecision()
    expect(() =>
      ingest([ev('decision.add-artifact', { decisionId: decId, artifact: { kind: 'h2a-decision-dossier', negotiationRef: 'neg-1' } })], ctx(), store),
    ).toThrow()
  })

  it('rejects an h2a-decision-dossier with no negotiationRef', () => {
    const decId = seedDecision()
    expect(() =>
      ingest([ev('decision.add-artifact', { decisionId: decId, artifact: { kind: 'h2a-decision-dossier', dossierHash: 'sha256:x' } })], ctx(), store),
    ).toThrow()
  })

  it('rejects a rendered-view with no viewRef', () => {
    const decId = seedDecision()
    expect(() =>
      ingest([ev('decision.add-artifact', { decisionId: decId, artifact: { kind: 'rendered-view', label: 'x' } })], ctx(), store),
    ).toThrow()
  })

  it('rejects a mockup with no viewRef', () => {
    const decId = seedDecision()
    expect(() =>
      ingest([ev('decision.add-artifact', { decisionId: decId, artifact: { kind: 'mockup' } })], ctx(), store),
    ).toThrow()
  })

  it('rejects an unknown artifact kind', () => {
    const decId = seedDecision()
    expect(() =>
      ingest([ev('decision.add-artifact', { decisionId: decId, artifact: { kind: 'something-else', viewRef: 'v' } })], ctx(), store),
    ).toThrow()
  })

  it('rejects a comprehension entry that omits subject or dossierHash', () => {
    const decId = seedDecision()
    expect(() =>
      ingest(
        [ev('decision.add-artifact', { decisionId: decId, artifact: { kind: 'h2a-decision-dossier', negotiationRef: 'n', dossierHash: 'sha256:x', comprehension: [{ dossierHash: 'sha256:x' }] } })],
        ctx(),
        store,
      ),
    ).toThrow()
  })

  it('accepts a minimal rendered-view and a minimal mockup', () => {
    const decId = seedDecision()
    expect(() => ingest([ev('decision.add-artifact', { decisionId: decId, artifact: { kind: 'rendered-view', viewRef: 'v://1' } })], ctx(), store)).not.toThrow()
    expect(() => ingest([ev('decision.add-artifact', { decisionId: decId, artifact: { kind: 'mockup', viewRef: 'v://2' } })], ctx(), store)).not.toThrow()
    const dossier = new Track(store).state().decisions.get(decId)!.dossier
    expect(dossier.artifacts).toHaveLength(2)
  })
})

describe('M5 — clientToken idempotency (append once)', () => {
  it('re-sending the same token appends exactly once', () => {
    const decId = seedDecision()
    const stream = [ev('decision.add-artifact', { decisionId: decId, artifact: DOSSIER_ARTIFACT }, 'art-1')]
    ingest(stream, ctx(), store)
    const after1 = store.readAll().length
    ingest(stream, ctx(), store)
    expect(store.readAll().length).toBe(after1) // skipped
    const dossier = new Track(store).state().decisions.get(decId)!.dossier
    expect(dossier.artifacts).toEqual([DOSSIER_ARTIFACT]) // appended ONCE
  })
})

describe('M5 — binding gate', () => {
  it('an unauthenticated channel CANNOT add an artifact (auth ∈ {local-user, signed})', () => {
    const decId = seedDecision()
    expect(() =>
      ingest([ev('decision.add-artifact', { decisionId: decId, artifact: DOSSIER_ARTIFACT })], ctx({ prov: UNAUTH, by: 'anon' }), store),
    ).toThrow(/binding write/)
  })

  it('a local-user channel CAN add an artifact', () => {
    const decId = seedDecision(ctx({ prov: LOCAL, by: 'human:carol' }))
    expect(() =>
      ingest([ev('decision.add-artifact', { decisionId: decId, artifact: DOSSIER_ARTIFACT })], ctx({ prov: LOCAL, by: 'human:carol' }), store),
    ).not.toThrow()
  })
})

describe('M5 — workspace containment (the bridge pinned to W cannot reach V)', () => {
  it('a channel pinned to W cannot add an artifact to a decision in V', () => {
    const decV = seedDecision(ctx({ workspace: 'V' }))
    expect(() =>
      ingest([ev('decision.add-artifact', { decisionId: decV, artifact: DOSSIER_ARTIFACT })], ctx({ workspace: 'W' }), store),
    ).toThrow(/workspace "V"/)
  })

  it('an allowedKinds capability that omits the kind rejects it', () => {
    const decId = seedDecision()
    expect(() =>
      ingest([ev('decision.add-artifact', { decisionId: decId, artifact: DOSSIER_ARTIFACT })], ctx({ allowedKinds: new Set<WorkEventKind>(['item.create']) }), store),
    ).toThrow(IngestError)
  })
})

describe('M5 — CLI≡ingest parity (facade command vs WorkEvent)', () => {
  it('Track.addDecisionArtifact and the decision.add-artifact WorkEvent produce the same fold', () => {
    // ingest path
    const decI = seedDecision()
    ingest([ev('decision.add-artifact', { decisionId: decI, artifact: DOSSIER_ARTIFACT })], ctx(), store)
    const viaIngest = new Track(store).state().decisions.get(decI)!.dossier.artifacts

    // facade path (a fresh store)
    const dir2 = mkdtempSync(join(tmpdir(), 'track-m5b-'))
    const store2 = new EventStore(join(dir2, '.track', 'events.jsonl'))
    const t2 = new Track(store2, { by: 'human:x', prov: LOCAL })
    const itemId = t2.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    const decF = t2.createDecision({ decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [itemId], dossier: { context: '', options: [], qa: [] } })
    t2.addDecisionArtifact(decF, DOSSIER_ARTIFACT)
    const viaFacade = t2.state().decisions.get(decF)!.dossier.artifacts
    rmSync(dir2, { recursive: true, force: true })

    expect(viaIngest).toEqual(viaFacade)
    expect(viaFacade).toEqual([DOSSIER_ARTIFACT])
  })

  it('the facade rejects an artifact for an unknown decision and a malformed union', () => {
    const t = new Track(store, { by: 'human:x', prov: LOCAL })
    expect(() => t.addDecisionArtifact('nope', DOSSIER_ARTIFACT)).toThrow()
    const itemId = t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    const decF = t.createDecision({ decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [itemId], dossier: { context: '', options: [], qa: [] } })
    expect(() => t.addDecisionArtifact(decF, { kind: 'h2a-decision-dossier', negotiationRef: 'n' } as DossierArtifact)).toThrow()
  })
})

describe('M5 — read surface exposes artifacts[] on the decision dossier', () => {
  it('report({decisions:true}) carries the appended artifacts', () => {
    const decId = seedDecision()
    ingest([ev('decision.add-artifact', { decisionId: decId, artifact: DOSSIER_ARTIFACT })], ctx(), store)
    const reader = new TrackReader(eventsPath)
    const report = reader.report({ baselineCommit: 'HEAD', decisions: true })
    const row = report.decisions!.find((d) => d.id === decId)!
    expect(row.artifacts).toEqual([DOSSIER_ARTIFACT])
  })
})
