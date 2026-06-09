import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import type { Provenance, Ulid } from '../events/types.js'
import { Track } from '../track.js'
import { runCli, type CliIO } from '../cli/index.js'
import type { WorkEvent, WorkEventKind } from './contract.js'
import { ingest, type IngestContext } from './ingest.js'
import { IngestError } from './map.js'

const now = (): string => '2026-06-07T00:00:00.000Z'
const counter = (): (() => Ulid) => {
  let i = 0
  return () => `id-${String(++i).padStart(4, '0')}`
}
const PROV: Provenance = { transport: 'import', proposed: false, auth: 'local-user' }
const WSJF = { userBusinessValue: 1, timeCriticality: 2, riskReductionOpportunityEnablement: 3, jobSize: 4 }
const ev = (kind: WorkEventKind, payload: Record<string, unknown>): WorkEvent => ({ v: 1, kind, payload })

let dir: string
let n = 0
const freshStore = (): EventStore => new EventStore(join(dir, `s${++n}`, '.track', 'events.jsonl'))
/** Default channel: local-user, workspace "ws", REAL ulids (so multiple calls on one store don't collide). */
const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({ by: 'human:t', workspace: 'ws', prov: PROV, ...over })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-ingest-'))
  n = 0
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ingest — parity: a WorkEvent stream ≡ the direct Track facade (anti-drift)', () => {
  it('produces byte-identical events to the equivalent direct calls, incl. cmdId batch & state-dependent outcome', () => {
    // DIRECT path = what the CLI does internally: facade calls with the canonical args, capturing ids.
    const directStore = freshStore()
    const direct = new Track(directStore, { by: 'human:t', now, newId: counter(), prov: PROV })
    const itemId = direct.createItem({ kind: 'feature', title: 'T', workspace: 'ws' })
    direct.setSpec(itemId, 'specified')
    const critId = direct.addCriterion(itemId, 's')
    const evId = direct.linkEvidence(critId, 'unit', 'l')
    direct.recordRun(evId, { commit: 'c1', env: 'ci', runner: 'gh', result: 'pass' })
    direct.assessPriority(itemId, WSJF)
    const decId = direct.createDecision({
      decisionKind: 'orientation',
      title: 'D',
      workspace: 'ws',
      targets: [itemId],
      dossier: { context: '', options: [], qa: [] },
    })
    direct.reviseDossier(decId, { context: 'x', options: [], qa: [] })
    direct.setOutcome(decId, 'go')
    direct.setRealization(itemId, 'in-progress')
    direct.setRealization(itemId, 'done') // terminal realize coverage
    const blkId = direct.openBlocker({ targetId: itemId, kind: 'dependency', ref: itemId, reason: '', resolutionRule: 'manual' })
    direct.resolveBlocker(blkId)

    // INGEST path: the SAME stream as WorkEvents, identical injected context (incl. prov); a fresh
    // counter mints in the same order ⇒ the captured ids line up.
    const ingestStore = freshStore()
    const result = ingest(
      [
        ev('item.create', { kind: 'feature', title: 'T', workspace: 'ws' }),
        ev('item.spec', { itemId, to: 'specified' }),
        ev('acceptance.criterion', { itemId, statement: 's' }),
        ev('acceptance.link', { criterionId: critId, kind: 'unit', locator: 'l' }),
        ev('acceptance.run', { evidenceId: evId, commit: 'c1', env: 'ci', runner: 'gh', result: 'pass' }),
        ev('priority.assess', { itemId, ...WSJF }),
        ev('decision.create', { decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [itemId], dossier: { context: '', options: [], qa: [] } }),
        ev('decision.dossier', { decisionId: decId, dossier: { context: 'x', options: [], qa: [] } }),
        ev('decision.outcome', { decisionId: decId, to: 'go' }),
        ev('item.realize', { itemId, to: 'in-progress' }),
        ev('item.realize', { itemId, to: 'done' }),
        ev('blocker.raise', { targetId: itemId, kind: 'dependency', ref: itemId, resolutionRule: 'manual' }),
        ev('blocker.resolve', { blockerId: blkId }),
      ],
      ctx({ now, newId: counter() }),
      ingestStore,
    )

    expect(ingestStore.readAll()).toEqual(directStore.readAll()) // byte-identical events
    expect(result.ids).toEqual([itemId, null, critId, evId, null, null, decId, null, null, null, null, blkId, null])
  })

  it('parity for governance/settling kinds: disposition, waive, and a no-go (rejected) batch', () => {
    const directStore = freshStore()
    const d = new Track(directStore, { by: 'human:t', now, newId: counter(), prov: PROV })
    const itemId = d.createItem({ kind: 'feature', title: 'T', workspace: 'ws' })
    const critId = d.addCriterion(itemId, 's')
    d.waive(critId, 'r')
    d.setDisposition(itemId, 'commitment', 'skipped')
    const decId = d.createDecision({ decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [itemId], dossier: { context: '', options: [], qa: [] } })
    d.setOutcome(decId, 'no-go') // emits decision.outcome + blocker.resolved + realization→rejected on the target

    const ingestStore = freshStore()
    ingest(
      [
        ev('item.create', { kind: 'feature', title: 'T', workspace: 'ws' }),
        ev('acceptance.criterion', { itemId, statement: 's' }),
        ev('acceptance.waive', { criterionId: critId, reason: 'r' }),
        ev('decision.disposition', { itemId, gate: 'commitment', disposition: 'skipped' }),
        ev('decision.create', { decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [itemId], dossier: { context: '', options: [], qa: [] } }),
        ev('decision.outcome', { decisionId: decId, to: 'no-go' }),
      ],
      ctx({ now, newId: counter() }),
      ingestStore,
    )
    expect(ingestStore.readAll()).toEqual(directStore.readAll())
  })
})

describe('ingest — workspace containment against folded state (the security property)', () => {
  it('rejects mutating an EXISTING aggregate in another workspace (no payload workspace to pin)', () => {
    const store = freshStore()
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'x', workspace: 'V' })], ctx({ workspace: 'V' }), store).ids[0]!
    const before = store.readAll().length
    expect(() => ingest([ev('priority.assess', { itemId, ...WSJF })], ctx({ workspace: 'W' }), store)).toThrow(IngestError)
    expect(() => ingest([ev('priority.assess', { itemId, ...WSJF })], ctx({ workspace: 'W' }), store)).toThrow(/belongs to workspace "V"/)
    expect(store.readAll().length).toBe(before) // nothing written
  })

  it('rejects a create whose payload.workspace differs from the channel', () => {
    expect(() => ingest([ev('item.create', { kind: 'feature', title: 'x', workspace: 'V' })], ctx({ workspace: 'W' }), freshStore())).toThrow(
      /must equal the channel workspace "W"/,
    )
  })

  it('rejects a decision.create that TARGETS an item in another workspace (decision opens a blocker on it)', () => {
    const store = freshStore()
    const vItem = ingest([ev('item.create', { kind: 'feature', title: 'x', workspace: 'V' })], ctx({ workspace: 'V' }), store).ids[0]!
    expect(() =>
      ingest(
        [ev('decision.create', { decisionKind: 'orientation', title: 'D', workspace: 'W', targets: [vItem], dossier: { context: '', options: [], qa: [] } })],
        ctx({ workspace: 'W' }),
        store,
      ),
    ).toThrow(/affects an aggregate in workspace "V"/)
  })

  it('rejects realizing a DECISION in another workspace (setRealization spans items ∪ decisions)', () => {
    const store = freshStore()
    const vItem = ingest([ev('item.create', { kind: 'feature', title: 'x', workspace: 'V' })], ctx({ workspace: 'V' }), store).ids[0]!
    const vDec = ingest(
      [ev('decision.create', { decisionKind: 'orientation', title: 'D', workspace: 'V', targets: [vItem], dossier: { context: '', options: [], qa: [] } })],
      ctx({ workspace: 'V' }),
      store,
    ).ids[0]!
    const before = store.readAll().length
    // A W channel — even UNAUTHENTICATED + non-binding `in-progress` (the easiest bypass) — must not reach the V decision.
    const unauthW = ctx({ workspace: 'W', prov: { transport: 'import', proposed: true, auth: 'unauthenticated' } })
    expect(() => ingest([ev('item.realize', { itemId: vDec, to: 'in-progress' })], unauthW, store)).toThrow(/belongs to workspace "V"/)
    expect(store.readAll().length).toBe(before) // nothing written
  })

  it('allows a within-workspace mutation', () => {
    const store = freshStore()
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'x', workspace: 'ws' })], ctx(), store).ids[0]!
    expect(() => ingest([ev('priority.assess', { itemId, ...WSJF })], ctx(), store)).not.toThrow()
  })
})

describe('ingest — binding gate (allowlist auth ∈ {local-user, signed})', () => {
  const unauth = (): IngestContext => ctx({ prov: { transport: 'import', proposed: true, auth: 'unauthenticated' } })

  it('lets an unauthenticated channel CREATE and prepare, but not SETTLE', () => {
    const store = freshStore()
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'x', workspace: 'ws' })], unauth(), store).ids[0]!
    expect(() => ingest([ev('item.spec', { itemId, to: 'specified' })], unauth(), store)).not.toThrow() // prepare OK
    expect(() => ingest([ev('item.realize', { itemId, to: 'in-progress' })], unauth(), store)).not.toThrow() // non-terminal OK
    expect(() => ingest([ev('item.realize', { itemId, to: 'done' })], unauth(), store)).toThrow(/binding write and requires an authenticated channel/)
    const critId = ingest([ev('acceptance.criterion', { itemId, statement: 's' })], unauth(), store).ids[0]!
    expect(() => ingest([ev('acceptance.waive', { criterionId: critId, reason: 'r' })], unauth(), store)).toThrow(/binding write/)
  })

  it('a local-user channel may settle (in-progress → done)', () => {
    const store = freshStore()
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'x', workspace: 'ws' })], ctx(), store).ids[0]!
    ingest([ev('item.realize', { itemId, to: 'in-progress' })], ctx(), store)
    expect(() => ingest([ev('item.realize', { itemId, to: 'done' })], ctx(), store)).not.toThrow()
  })
})

describe('ingest — capability allowlist + at-least-once', () => {
  it('rejects a kind outside the channel allowlist', () => {
    expect(() =>
      ingest([ev('item.create', { kind: 'feature', title: 'x', workspace: 'ws' })], ctx({ allowedKinds: new Set(['item.spec']) }), freshStore()),
    ).toThrow(/not permitted by this channel's capability/)
  })

  it('is at-least-once: re-ingesting the same create stream re-applies (documented stance)', () => {
    const store = freshStore()
    const stream = [ev('item.create', { kind: 'feature', title: 'dup', workspace: 'ws' })]
    ingest(stream, ctx(), store)
    ingest(stream, ctx(), store)
    expect(store.readAll().filter((e) => e.type === 'item.created').length).toBe(2)
  })
})

describe('track ingest <file> — local CLI verb', () => {
  let cliDir: string
  let out: string[]
  let io: CliIO
  beforeEach(() => {
    cliDir = mkdtempSync(join(tmpdir(), 'track-ingest-cli-'))
    out = []
    io = { cwd: cliDir, out: (s) => out.push(s), err: (s) => out.push(s) }
    // P0: a mutating command no longer auto-creates `.track` — only `init` does. Initialize first.
    runCli(['init'], io)
    out.length = 0
  })
  afterEach(() => rmSync(cliDir, { recursive: true, force: true }))

  it('applies a WorkEvent JSONL file and prints assigned ids', () => {
    const file = join(cliDir, 'work.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ v: 1, kind: 'item.create', payload: { kind: 'feature', title: 'A', workspace: 'ws' } }),
        '', // blank lines tolerated
        JSON.stringify({ v: 1, kind: 'item.create', payload: { kind: 'bug', title: 'B', workspace: 'ws' } }),
      ].join('\n'),
    )
    expect(runCli(['ingest', file, '--workspace', 'ws'], io)).toBe(0)
    const events = new EventStore(join(cliDir, '.track', 'events.jsonl')).readAll()
    expect(events.filter((e) => e.type === 'item.created').length).toBe(2)
    expect(events[0]!.prov).toEqual({ transport: 'import', proposed: false, auth: 'local-user' }) // batch-distinct provenance
    expect(out.join('').trim().split('\n').length).toBe(2) // two ids printed
  })

  it('requires --workspace', () => {
    const file = join(cliDir, 'w.jsonl')
    writeFileSync(file, JSON.stringify({ v: 1, kind: 'item.create', payload: { kind: 'feature', title: 'A', workspace: 'ws' } }))
    expect(runCli(['ingest', file], io)).toBe(1) // req() throws DomainError → exit 1
    expect(out.join('')).toMatch(/missing required --workspace/)
  })

  it('refuses a cross-workspace write (the pin holds through the CLI)', () => {
    const file = join(cliDir, 'x.jsonl')
    writeFileSync(file, JSON.stringify({ v: 1, kind: 'item.create', payload: { kind: 'feature', title: 'A', workspace: 'OTHER' } }))
    expect(runCli(['ingest', file, '--workspace', 'ws'], io)).toBe(1)
    expect(out.join('')).toMatch(/must equal the channel workspace "ws"/)
  })
})
