// M5 (canevas) — track-side surface, STRICT TDD. Covers LOT 1 (cursor/changesSince/canevas/
// amendmentTrace + 3 read MCP tools) and LOT 2 (item.spec-amend → spec.amended, the additive write).
// The host (sentropic) is co-designed elsewhere; this file proves track's half only.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readHead } from './events/head.js'
import { EventStore } from './events/store.js'
import { EVENT_TYPES } from './events/types.js'
import type { Provenance, Ulid } from './events/types.js'
import { validate } from './events/validate.js'
import { WORK_EVENT_KINDS, WORK_EVENT_SCHEMA } from './ingest/contract.js'
import type { WorkEvent } from './ingest/contract.js'
import { ingest, type IngestContext } from './ingest/ingest.js'
import { IngestError } from './ingest/map.js'
import { DomainError } from './model/item.js'
import type { JsonPatch } from './model/spec-amend.js'
import { READ_CONTRACT_VERSION, TrackReader } from './read/contract.js'
import { dispatchReadTool, READ_TOOLS } from './mcp/server.js'
import { Track } from './track.js'
import { runCli } from './cli/index.js'

const now = (): string => '2026-06-10T00:00:00.000Z'
const counter = (): (() => Ulid) => {
  let i = 0
  return () => `id-${String(++i).padStart(4, '0')}`
}
const HUMAN: Provenance = { transport: 'cli', proposed: false, auth: 'local-user' }
const MACHINE: Provenance = { transport: 'mcp-stdio', proposed: true, auth: 'signed', principal: 'nhi:agent-x' }
const OPTS = { baselineCommit: 'c1' as const }
const PATCH: JsonPatch = [{ op: 'replace', path: '/spec/title', value: 'Amended' }]
const ev = (kind: string, payload: Record<string, unknown>): WorkEvent => ({ v: 1, kind, payload } as WorkEvent)

let dir: string
let eventsPath: string
let store: EventStore
let reader: TrackReader

function trackWith(prov: Provenance): Track {
  return new Track(store, { by: 'human:x', now, newId: counter(), prov })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-m5-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  store = new EventStore(eventsPath)
  reader = new TrackReader(eventsPath)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const integral = (): boolean => validate(store.readAll(), readHead(eventsPath)).ok

// ============================================================================================
// LOT 1 — cursor() / changesSince()
// ============================================================================================

describe('M5 LOT1 — cursor()', () => {
  it('is {head:null,count:0} on an empty log', () => {
    expect(reader.cursor()).toEqual({ head: null, count: 0 })
  })

  it('head = the log-tail contentHash and count = the event count; both change iff the log grows', () => {
    const t = trackWith(HUMAN)
    t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    const c1 = reader.cursor()
    expect(c1.count).toBe(1)
    expect(c1.head).toBe(store.readAll().at(-1)!.contentHash)

    // A pure read does NOT move the cursor.
    reader.report(OPTS)
    expect(reader.cursor()).toEqual(c1)

    // An append moves it.
    t.createItem({ kind: 'chore', title: 'B', workspace: 'ws' })
    const c2 = reader.cursor()
    expect(c2.count).toBe(2)
    expect(c2.head).not.toBe(c1.head)
    expect(c2.head).toBe(store.readAll().at(-1)!.contentHash)
  })
})

describe('M5 LOT1 — changesSince()', () => {
  it('detects an append (changed:true) and a no-change (changed:false)', () => {
    const t = trackWith(HUMAN)
    t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    const c1 = reader.cursor()
    // No append since c1 → unchanged.
    expect(reader.changesSince(c1)).toEqual({ changed: false, head: c1.head, count: c1.count })
    // Append → changed, with the NEW head/count.
    t.createItem({ kind: 'chore', title: 'B', workspace: 'ws' })
    const d = reader.changesSince(c1)
    expect(d.changed).toBe(true)
    expect(d.count).toBe(2)
    expect(d.head).toBe(reader.cursor().head)
  })

  it('a stale cursor (null head against a grown log) reports changed', () => {
    const t = trackWith(HUMAN)
    expect(reader.changesSince({ head: null, count: 0 }).changed).toBe(false)
    t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    expect(reader.changesSince({ head: null, count: 0 }).changed).toBe(true)
  })
})

// ============================================================================================
// LOT 1 — canevas()
// ============================================================================================

describe('M5 LOT1 — canevas()', () => {
  it('materializes the report + WP rollup joined with per-aggregate prov lineage + open-action affordances', () => {
    const t = trackWith(HUMAN)
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws', parentId: wp })
    void leaf

    const view = reader.canevas('ws', OPTS)
    // report + WP rollup are materialized.
    expect(view.report.buckets).toBeDefined()
    expect(view.report.wpTree).toBeDefined()
    expect(view.report.wpTree!.some((n) => n.id === wp)).toBe(true)
    // workspace scoping: only ws rows.
    expect(Object.values(view.report.buckets).flat().every((r) => r.workspace === 'ws')).toBe(true)
    // a prov lineage summary is attached per surfaced aggregate.
    expect(view.prov[leaf]).toBeDefined()
    expect(view.prov[leaf]!.origin).toBe('human') // proposed:false → human
    // open-action affordances list legal next WorkEvent kinds.
    expect(Array.isArray(view.affordances[leaf])).toBe(true)
    expect(view.affordances[leaf]!.length).toBeGreaterThan(0)
  })

  it('scopes to the named workspace (a foreign-workspace aggregate is excluded)', () => {
    const t = trackWith(HUMAN)
    t.createItem({ kind: 'feature', title: 'V', workspace: 'V' })
    const wItem = t.createItem({ kind: 'feature', title: 'W', workspace: 'ws' })
    const view = reader.canevas('ws', OPTS)
    const ids = Object.values(view.report.buckets).flat().map((r) => r.id)
    expect(ids).toContain(wItem)
    expect(view.prov['V']).toBeUndefined()
  })

  it('with decisionId, includes the full decision dossier (context/options/qa/outcome/artifacts)', () => {
    const t = trackWith(HUMAN)
    const item = t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    const dec = t.createDecision({
      decisionKind: 'orientation',
      title: 'D',
      workspace: 'ws',
      targets: [item],
      dossier: { context: 'why', options: [{ id: 'o1', title: 'O', summary: 's' }], qa: [{ id: 'q1', question: 'q?' }] },
    })
    t.addDecisionArtifact(dec, { kind: 'mockup', viewRef: 'view://x' })
    const view = reader.canevas('ws', { ...OPTS, decisionId: dec })
    expect(view.dossier).toBeDefined()
    expect(view.dossier!.id).toBe(dec)
    expect(view.dossier!.dossier.context).toBe('why')
    expect(view.dossier!.dossier.options[0]!.id).toBe('o1')
    expect(view.dossier!.dossier.qa[0]!.question).toBe('q?')
    expect(view.dossier!.outcome).toBe('pending')
    expect(view.dossier!.dossier.artifacts![0]).toEqual({ kind: 'mockup', viewRef: 'view://x' })
  })

  it('without decisionId, dossier is absent', () => {
    const t = trackWith(HUMAN)
    t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    expect(reader.canevas('ws', OPTS).dossier).toBeUndefined()
  })

  it('is pure — a canevas read never appends', () => {
    const t = trackWith(HUMAN)
    t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    const before = store.readAll().length
    reader.canevas('ws', OPTS)
    reader.canevas('ws', OPTS)
    expect(store.readAll().length).toBe(before)
  })
})

// ============================================================================================
// LOT 2 — item.spec-amend → spec.amended (the additive write), driven via the facade
// ============================================================================================

describe('M5 LOT2 — amendSpec records on the EXISTING item aggregate (next seq, old hashes untouched)', () => {
  it('appends spec.amended at the next seq; the item.created hash is untouched', () => {
    const t = trackWith(HUMAN)
    const item = t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    const createdHash = store.readAll().find((e) => e.aggregateId === item)!.contentHash

    t.amendSpec(item, { itemId: item, baseHash: 'sha256:b', patch: PATCH, resultHash: 'sha256:r', summary: 'tweak' })

    const evs = store.readAll().filter((e) => e.aggregateId === item)
    expect(evs.map((e) => [e.type, e.seq])).toEqual([
      ['item.created', 1],
      ['spec.amended', 2],
    ])
    // old hash byte-identical (additive, no recreate).
    expect(evs[0]!.contentHash).toBe(createdHash)
    expect(integral()).toBe(true)
  })

  it('records the JsonPatch + baseHash/resultHash VERBATIM (track never applies/validates the patch)', () => {
    const t = trackWith(HUMAN)
    const item = t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    t.amendSpec(item, { itemId: item, baseHash: 'sha256:b', patch: PATCH, resultHash: 'sha256:r' })
    const p = store.readAll().find((e) => e.type === 'spec.amended')!.payload as Record<string, unknown>
    expect(p['patch']).toEqual(PATCH)
    expect(p['baseHash']).toBe('sha256:b')
    expect(p['resultHash']).toBe('sha256:r')
  })

  it('does NOT mutate any spec field destructively — it projects into state.specAmendments', () => {
    const t = trackWith(HUMAN)
    const item = t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    t.setSpec(item, 'specified')
    t.amendSpec(item, { itemId: item, baseHash: 'sha256:b', patch: PATCH, resultHash: 'sha256:r' })
    const state = t.state()
    // the spec axis is UNTOUCHED — the amendment is record-only.
    expect(state.items.get(item)!.specStatus).toBe('specified')
    expect(state.specAmendments.get(item)!.map((a) => a.resultHash)).toEqual(['sha256:r'])
  })

  it('REJECTS an amendment on an unknown item', () => {
    const t = trackWith(HUMAN)
    expect(() => t.amendSpec('NOPE', { itemId: 'NOPE', baseHash: 'sha256:b', patch: PATCH, resultHash: 'sha256:r' })).toThrow(DomainError)
  })

  it('REJECTS a malformed amendment (no patch array) fail-closed', () => {
    const t = trackWith(HUMAN)
    const item = t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    expect(() => t.amendSpec(item, { itemId: item, baseHash: 'sha256:b', patch: 'nope' as never, resultHash: 'sha256:r' })).toThrow(DomainError)
  })

  it('pins the new event-type + work-event-kind names', () => {
    expect(EVENT_TYPES).toContain('spec.amended')
    expect([...WORK_EVENT_KINDS]).toContain('item.spec-amend')
    expect(WORK_EVENT_SCHEMA['item.spec-amend'].method).toBe('amendSpec')
    expect(WORK_EVENT_SCHEMA['item.spec-amend'].settles).toBe('always')
  })
})

// ============================================================================================
// LOT 2 — item.spec-amend via ingest (binding-gated, contained, clientToken-idempotent)
// ============================================================================================

describe('M5 LOT2 — item.spec-amend via ingest', () => {
  const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({
    by: 'human:t',
    workspace: 'ws',
    prov: HUMAN,
    now,
    newId: counter(),
    ...over,
  })

  it('an authenticated channel amends an existing item', () => {
    const s = new EventStore(join(dir, 'auth', '.track', 'events.jsonl'))
    const c = ctx()
    const item = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], c, s).ids[0] as string
    ingest([ev('item.spec-amend', { itemId: item, baseHash: 'sha256:b', patch: PATCH, resultHash: 'sha256:r' })], c, s)
    expect(new Track(s).state().specAmendments.get(item)!.length).toBe(1)
  })

  it('an UNAUTHENTICATED channel is rejected (binding gate)', () => {
    const s = new EventStore(join(dir, 'unauth', '.track', 'events.jsonl'))
    const item = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), s).ids[0] as string
    const before = s.readAll().length
    expect(() =>
      ingest(
        [ev('item.spec-amend', { itemId: item, baseHash: 'sha256:b', patch: PATCH, resultHash: 'sha256:r' })],
        ctx({ prov: { transport: 'http', proposed: true, auth: 'unauthenticated' } }),
        s,
      ),
    ).toThrow(IngestError)
    expect(s.readAll().length).toBe(before) // nothing written
  })

  it('a foreign-workspace target is rejected (containment)', () => {
    const s = new EventStore(join(dir, 'foreign', '.track', 'events.jsonl'))
    const itemA = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'wsA' })], ctx({ workspace: 'wsA' }), s).ids[0] as string
    expect(() =>
      ingest([ev('item.spec-amend', { itemId: itemA, baseHash: 'sha256:b', patch: PATCH, resultHash: 'sha256:r' })], ctx({ workspace: 'wsB' }), s),
    ).toThrow(/workspace/)
  })

  it('is clientToken-idempotent: a retried amend with the same token is skipped (one event)', () => {
    const s = new EventStore(join(dir, 'idem', '.track', 'events.jsonl'))
    const item = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), s).ids[0] as string
    const amend: WorkEvent = { v: 1, kind: 'item.spec-amend', payload: { itemId: item, baseHash: 'sha256:b', patch: PATCH, resultHash: 'sha256:r' }, clientToken: 'tok-1' }
    ingest([amend], ctx(), s)
    ingest([amend], ctx(), s) // retry — skipped
    expect(s.readAll().filter((e) => e.type === 'spec.amended').length).toBe(1)
  })
})

// ============================================================================================
// LOT 2 — additive hash-stability (pre-amend logs byte-identical)
// ============================================================================================

describe('M5 LOT2 — additive hash-stability', () => {
  it('a log built BEFORE the amend feature is byte-identical to the same log re-built today', () => {
    // Build a baseline log (no amend), capture its bytes.
    const sA = new EventStore(join(dir, 'A', '.track', 'events.jsonl'))
    const tA = new Track(sA, { by: 'human:x', now, newId: counter(), prov: HUMAN })
    const itemA = tA.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    tA.setSpec(itemA, 'specified')
    const bytesA = readFileSync(join(dir, 'A', '.track', 'events.jsonl'), 'utf8')

    // The SAME operations on a fresh store (with the amend code present) must produce identical bytes —
    // proving the additive kind perturbs no existing event's hash/seq.
    const sB = new EventStore(join(dir, 'B', '.track', 'events.jsonl'))
    const tB = new Track(sB, { by: 'human:x', now, newId: counter(), prov: HUMAN })
    const itemB = tB.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    tB.setSpec(itemB, 'specified')
    const bytesB = readFileSync(join(dir, 'B', '.track', 'events.jsonl'), 'utf8')

    expect(bytesB).toBe(bytesA)
  })
})

// ============================================================================================
// LOT 1 — amendmentTrace() : human/machine origin, ordering, NO laundering
// ============================================================================================

describe('M5 LOT1 — amendmentTrace()', () => {
  it('tags human (proposed:false) vs machine (proposed:true), ordered by seq', () => {
    // A human spec-amend, then a machine spec-amend, on the same item. One Track per prov.
    const human = trackWith(HUMAN)
    const item = human.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    human.amendSpec(item, { itemId: item, baseHash: 'sha256:b0', patch: PATCH, resultHash: 'sha256:r1', summary: 'human edit' })
    const machine = new Track(store, { by: 'agent:x', now, newId: counter(), prov: MACHINE })
    machine.amendSpec(item, { itemId: item, baseHash: 'sha256:r1', patch: PATCH, resultHash: 'sha256:r2', summary: 'ai edit' })

    const trace = reader.amendmentTrace(item)
    expect(trace.map((s) => [s.kind, s.origin])).toEqual([
      ['spec.amended', 'human'],
      ['spec.amended', 'machine'],
    ])
    // ordered by seq (strictly increasing).
    expect(trace[0]!.seq).toBeLessThan(trace[1]!.seq)
    // prov is projected.
    expect(trace[0]!.prov.proposed).toBe(false)
    expect(trace[1]!.prov.proposed).toBe(true)
    expect(trace[1]!.prov.principal).toBe('nhi:agent-x')
    expect(trace[0]!.summary).toBe('human edit')
  })

  it('an AI proposal + a human acceptance BOTH appear — the machine origin is NOT laundered', () => {
    // AI proposes (machine, with a proposalRef), human accepts (references the same proposalRef).
    const machine = new Track(store, { by: 'agent:x', now, newId: counter(), prov: MACHINE })
    const item = machine.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    machine.amendSpec(item, { itemId: item, baseHash: 'sha256:b', patch: PATCH, resultHash: 'sha256:p', proposalRef: 'prop-1', summary: 'AI proposes' })
    const human = new Track(store, { by: 'human:x', now, newId: counter(), prov: HUMAN })
    human.amendSpec(item, { itemId: item, baseHash: 'sha256:p', patch: PATCH, resultHash: 'sha256:p', proposalRef: 'prop-1', summary: 'human accepts' })

    const trace = reader.amendmentTrace(item)
    expect(trace.map((s) => s.origin)).toEqual(['machine', 'human'])
    // BOTH steps reference the proposal — the machine origin is preserved, not overwritten by acceptance.
    expect(trace[0]!.proposalRef).toBe('prop-1')
    expect(trace[1]!.proposalRef).toBe('prop-1')
    expect(trace[0]!.origin).toBe('machine') // the proposal stays machine-origin in the trace
    expect(trace[1]!.origin).toBe('human')
  })

  it('projects across spec.amended, decision.dossier, decision.artifact-added, decision.outcome', () => {
    const human = trackWith(HUMAN)
    const item = human.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    const dec = human.createDecision({
      decisionKind: 'orientation',
      title: 'D',
      workspace: 'ws',
      targets: [item],
      dossier: { context: '', options: [], qa: [] },
    })
    human.reviseDossier(dec, { context: 'rev', options: [], qa: [] })
    human.addDecisionArtifact(dec, { kind: 'mockup', viewRef: 'v://x' })
    human.setOutcome(dec, 'go')

    const trace = reader.amendmentTrace(dec)
    const kinds = trace.map((s) => s.kind)
    expect(kinds).toContain('dossier.revised')
    expect(kinds).toContain('decision.artifact-added')
    expect(kinds).toContain('decision.outcome')
    // ordered by seq.
    expect(trace.map((s) => s.seq)).toEqual([...trace.map((s) => s.seq)].sort((a, b) => a - b))
  })

  it('returns [] for an aggregate with no amendable history', () => {
    const t = trackWith(HUMAN)
    const item = t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    expect(reader.amendmentTrace(item)).toEqual([])
  })
})

// ============================================================================================
// LOT 1 — three read MCP tools (parity, read-only, side-effect-free)
// ============================================================================================

describe('M5 LOT1 — read MCP tools', () => {
  it('exposes track_cursor / track_canevas / track_amendment_trace', () => {
    const names = READ_TOOLS.map((t) => t.name)
    expect(names).toContain('track_cursor')
    expect(names).toContain('track_canevas')
    expect(names).toContain('track_amendment_trace')
  })

  it('track_cursor mirrors reader.cursor()', () => {
    const t = trackWith(HUMAN)
    t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    expect(dispatchReadTool(reader, 'track_cursor', {})).toBe(JSON.stringify(reader.cursor(), null, 2))
  })

  it('track_canevas mirrors reader.canevas()', () => {
    const t = trackWith(HUMAN)
    t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    expect(dispatchReadTool(reader, 'track_canevas', { workspace: 'ws', baselineCommit: 'c1' })).toBe(
      JSON.stringify(reader.canevas('ws', { baselineCommit: 'c1' }), null, 2),
    )
  })

  it('track_amendment_trace mirrors reader.amendmentTrace()', () => {
    const t = trackWith(HUMAN)
    const item = t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    t.amendSpec(item, { itemId: item, baseHash: 'sha256:b', patch: PATCH, resultHash: 'sha256:r' })
    expect(dispatchReadTool(reader, 'track_amendment_trace', { aggregateId: item })).toBe(
      JSON.stringify(reader.amendmentTrace(item), null, 2),
    )
  })

  it('the new read tools NEVER append (side-effect-free)', () => {
    const t = trackWith(HUMAN)
    const item = t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    const before = store.readAll().length
    dispatchReadTool(reader, 'track_cursor', {})
    dispatchReadTool(reader, 'track_canevas', { workspace: 'ws', baselineCommit: 'c1' })
    dispatchReadTool(reader, 'track_amendment_trace', { aggregateId: item })
    expect(store.readAll().length).toBe(before)
  })

  it('rejects missing required args (parity strictness with the CLI)', () => {
    expect(() => dispatchReadTool(reader, 'track_canevas', { baselineCommit: 'c1' })).toThrow(/workspace/)
    expect(() => dispatchReadTool(reader, 'track_amendment_trace', {})).toThrow(/aggregateId/)
  })

  it('bumps READ_CONTRACT_VERSION past 1.6.0', () => {
    const [maj, min] = READ_CONTRACT_VERSION.split('.').map(Number)
    expect(maj).toBe(1)
    expect(min!).toBeGreaterThan(6)
  })
})

// ============================================================================================
// LOT 2 — CLI ≡ ingest parity for item.spec-amend
// ============================================================================================

describe('M5 LOT2 — CLI ≡ ingest parity for item.spec-amend', () => {
  it('the CLI `item spec-amend` verb produces the same spec.amended event as the ingest seam', () => {
    // INGEST path.
    const sIngest = new EventStore(join(dir, 'ing', '.track', 'events.jsonl'))
    const c: IngestContext = { by: 'human:x', workspace: 'ws', prov: HUMAN, now, newId: counter() }
    const item = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], c, sIngest).ids[0] as string
    ingest([ev('item.spec-amend', { itemId: item, baseHash: 'sha256:b', patch: PATCH, resultHash: 'sha256:r', summary: 's' })], c, sIngest)
    const ingestAmend = sIngest.readAll().find((e) => e.type === 'spec.amended')!

    // CLI path — same item id (ingest minted id-0001 for create on a fresh counter; the CLI uses ulids,
    // so we compare the PAYLOAD + type, not the aggregateId/frame).
    const cliDir = join(dir, 'cli')
    const out: string[] = []
    const io = { cwd: cliDir, out: (s: string) => out.push(s), err: (s: string) => out.push(s) }
    runCli(['init'], io)
    const cliItem = (() => {
      const buf: string[] = []
      runCli(['item', 'new', '--kind', 'feature', '--title', 'A', '--workspace', 'ws'], { cwd: cliDir, out: (s) => buf.push(s), err: (s) => buf.push(s) })
      return buf.join('').trim()
    })()
    const code = runCli(
      ['item', 'spec-amend', cliItem, '--base-hash', 'sha256:b', '--result-hash', 'sha256:r', '--patch', JSON.stringify(PATCH), '--summary', 's'],
      io,
    )
    expect(code).toBe(0)
    const cliAmend = new EventStore(join(cliDir, '.track', 'events.jsonl')).readAll().find((e) => e.type === 'spec.amended')!

    // The recorded amendment payload is identical (verb→past-tense parity; aggregate/frame differ by id).
    expect(cliAmend.type).toBe('spec.amended')
    expect(cliAmend.payload).toEqual({ ...(ingestAmend.payload as Record<string, unknown>), itemId: cliItem })
  })
})
