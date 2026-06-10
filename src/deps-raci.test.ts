import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { contentHashOf } from './events/frame.js'
import { readHead } from './events/head.js'
import { EventStore } from './events/store.js'
import type { EventCore, Provenance, TrackEvent } from './events/types.js'
import { validate } from './events/validate.js'
import { ingest, type IngestContext } from './ingest/ingest.js'
import { DomainError } from './model/item.js'
import { TrackReader } from './read/contract.js'
import { reportText } from './read/commands.js'
import { Track } from './track.js'
import { runCli, type CliIO } from './cli/index.js'

let dir: string
let eventsPath: string
let store: EventStore
let t: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-raci-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  store = new EventStore(eventsPath)
  t = new Track(store, { by: 'human:x', now: () => '2026-06-08T00:00:00.000Z' })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const integral = (): boolean => validate(store.readAll(), readHead(eventsPath)).ok

describe('Lot A — RACI fields on items & decisions (additive)', () => {
  it('persists accountable + responsible + engagementRef on an item and folds them', () => {
    const id = t.createItem({
      kind: 'feature',
      title: 'X',
      workspace: 'ws',
      accountable: 'human:alice',
      responsible: ['agent:codex', 'human:bob'],
      engagementRef: 'eng-123',
    })
    const item = t.state().items.get(id)!
    expect(item.accountable).toBe('human:alice')
    expect(item.responsible).toEqual(['agent:codex', 'human:bob'])
    expect(item.engagementRef).toBe('eng-123')
    expect(integral()).toBe(true)
  })

  it('accountable on a decision IS the sponsor (D6 resolved)', () => {
    const itm = t.createItem({ kind: 'feature', title: 'T', workspace: 'ws' })
    const d = t.createDecision({
      decisionKind: 'orientation',
      title: 'D',
      workspace: 'ws',
      targets: [itm],
      dossier: { context: '', options: [], qa: [] },
      accountable: 'human:carol',
      engagementRef: 'eng-9',
    })
    const dec = t.state().decisions.get(d)!
    expect(dec.accountable).toBe('human:carol')
    expect(dec.engagementRef).toBe('eng-9')
    expect(integral()).toBe(true)
  })

  it('omits the fields when not supplied (hash-identical to a pre-Lot-A event)', () => {
    t.createItem({ kind: 'feature', title: 'X', workspace: 'ws' })
    const payload = store.readAll()[0]!.payload as Record<string, unknown>
    expect('accountable' in payload).toBe(false)
    expect('responsible' in payload).toBe(false)
    expect('engagementRef' in payload).toBe(false)
    expect(integral()).toBe(true)
  })
})

describe('Lot A — dependency blocker scope: intra vs extra', () => {
  const item = (title: string): string => t.createItem({ kind: 'feature', title, workspace: 'ws' })

  it('intra (default) keeps the local-ref invariant; scope stays implicit', () => {
    const a = item('A')
    const b = item('B')
    const blk = t.openBlocker({ targetId: a, kind: 'dependency', ref: b, reason: '', resolutionRule: 'manual' })
    const bs = t.state().blockers.get(blk)!
    expect(bs.scope).toBeUndefined() // intra is the default — no field (backward-compatible)
    expect(bs.ref).toBe(b)
  })

  it('intra rejects an unknown ref (existing guard)', () => {
    const a = item('A')
    expect(() => t.openBlocker({ targetId: a, kind: 'dependency', ref: 'NOPE', reason: '' })).toThrow(DomainError)
  })

  it('extra requires engagementRef, FORBIDS a local ref, resolves manually', () => {
    const a = item('A')
    const blk = t.openBlocker({ targetId: a, kind: 'dependency', scope: 'extra', engagementRef: 'eng-ext-1', reason: 'blocked on cross-repo X' })
    const bs = t.state().blockers.get(blk)!
    expect(bs.scope).toBe('extra')
    expect(bs.engagementRef).toBe('eng-ext-1')
    expect(bs.ref).toBeUndefined()
    expect(bs.resolutionRule).toBe('manual')
    expect(bs.open).toBe(true)
    t.resolveBlocker(blk) // a human or the M3 bridge writes the resolve; track never reads h2a
    expect(t.state().blockers.get(blk)!.open).toBe(false)
    expect(integral()).toBe(true)
  })

  it('extra REJECTS a local ref', () => {
    const a = item('A')
    const b = item('B')
    expect(() =>
      t.openBlocker({ targetId: a, kind: 'dependency', scope: 'extra', ref: b, engagementRef: 'e', reason: '' }),
    ).toThrow(/must NOT carry a local ref/)
  })

  it('extra REQUIRES an engagementRef', () => {
    const a = item('A')
    expect(() => t.openBlocker({ targetId: a, kind: 'dependency', scope: 'extra', reason: '' })).toThrow(/requires an engagementRef/)
  })

  it("extra REJECTS a non-manual resolution rule (track can't see h2a state)", () => {
    const a = item('A')
    expect(() =>
      t.openBlocker({ targetId: a, kind: 'dependency', scope: 'extra', engagementRef: 'e', resolutionRule: 'linked-done', reason: '' }),
    ).toThrow(/manual' only/)
  })
})

describe('Lot A — the WorkEvent ingest path carries the new fields', () => {
  const PROV: Provenance = { transport: 'import', proposed: false, auth: 'local-user' }
  const ctx: IngestContext = { by: 'human:x', workspace: 'ws', prov: PROV }

  it('ingests RACI fields on item.create', () => {
    const r = ingest(
      [{ v: 1, kind: 'item.create', payload: { kind: 'feature', title: 'X', workspace: 'ws', accountable: 'human:a', responsible: ['agent:c'], engagementRef: 'eng-1' } }],
      ctx,
      store,
    )
    const item = t.state().items.get(r.ids[0]!)!
    expect(item.accountable).toBe('human:a')
    expect(item.responsible).toEqual(['agent:c'])
    expect(item.engagementRef).toBe('eng-1')
  })

  it('ingests an extra-scope dependency blocker', () => {
    const a = ingest([{ v: 1, kind: 'item.create', payload: { kind: 'feature', title: 'A', workspace: 'ws' } }], ctx, store).ids[0]!
    const r = ingest([{ v: 1, kind: 'blocker.raise', payload: { targetId: a, kind: 'dependency', scope: 'extra', engagementRef: 'eng-x', reason: '' } }], ctx, store)
    const blk = t.state().blockers.get(r.ids[0]!)!
    expect(blk.scope).toBe('extra')
    expect(blk.engagementRef).toBe('eng-x')
    expect(blk.ref).toBeUndefined()
  })

  it('rejects an extra blocker carrying a local ref, via ingest', () => {
    const a = ingest([{ v: 1, kind: 'item.create', payload: { kind: 'feature', title: 'A', workspace: 'ws' } }], ctx, store).ids[0]!
    expect(() =>
      ingest([{ v: 1, kind: 'blocker.raise', payload: { targetId: a, kind: 'dependency', scope: 'extra', ref: a, engagementRef: 'e', reason: '' } }], ctx, store),
    ).toThrow(/must NOT carry a local ref/)
  })

  it('ingests accountable (= sponsor) + engagementRef on a decision', () => {
    const itm = ingest([{ v: 1, kind: 'item.create', payload: { kind: 'feature', title: 'T', workspace: 'ws' } }], ctx, store).ids[0]!
    const d = ingest(
      [{ v: 1, kind: 'decision.create', payload: { decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [itm], dossier: { context: '', options: [], qa: [] }, accountable: 'human:carol', engagementRef: 'eng-9' } }],
      ctx,
      store,
    ).ids[0]!
    const dec = t.state().decisions.get(d)!
    expect(dec.accountable).toBe('human:carol')
    expect(dec.engagementRef).toBe('eng-9')
  })
})

describe('Lot A — validate() fail-closes a self-consistent but illegal blocker (frame intact)', () => {
  const at = '2026-06-08T00:00:00.000Z'
  const frame = (core: EventCore, prevHash: TrackEvent['prevHash'], seq: number): TrackEvent => ({
    ...core,
    seq,
    prevHash,
    contentHash: contentHashOf(core),
  })
  // a valid item.created to chain from, so only the blocker's SEMANTIC rule can fail (frame stays valid)
  const item = frame(
    { id: 'id-1', type: 'item.created', aggregate: 'item', aggregateId: 'item-1', at, by: 'human:x', payload: { kind: 'feature', title: 'A', workspace: 'ws' } },
    null,
    1,
  )
  const withBlockerPayload = (payload: Record<string, unknown>): TrackEvent[] => [
    item,
    frame({ id: 'id-2', type: 'blocker.opened', aggregate: 'blocker', aggregateId: 'blk-1', at, by: 'human:x', payload }, item.contentHash, 1),
  ]
  const base = { blockerId: 'blk-1', targetId: 'item-1', reason: '' }

  const bad: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['extra carrying a local ref', { ...base, kind: 'dependency', scope: 'extra', engagementRef: 'e', ref: 'item-1' }],
    ['extra with a linked-done rule (would fold non-manual, unresolvable)', { ...base, kind: 'dependency', scope: 'extra', engagementRef: 'e', resolutionRule: 'linked-done' }],
    ['extra with an empty engagementRef', { ...base, kind: 'dependency', scope: 'extra', engagementRef: '' }],
    ['intra dependency with no ref', { ...base, kind: 'dependency' }],
    ['decision blocker with no ref', { ...base, kind: 'decision' }],
  ]
  it.each(bad)('flags a malformed blocker: %s', (_name, payload) => {
    const res = validate(withBlockerPayload(payload))
    expect(res.findings.map((f) => f.kind)).toEqual(['blocker-scope']) // ONLY the semantic finding — frame is valid
  })

  it('accepts a well-formed extra blocker (no finding)', () => {
    const res = validate(withBlockerPayload({ ...base, kind: 'dependency', scope: 'extra', engagementRef: 'e', resolutionRule: 'manual' }))
    expect(res.findings.filter((f) => f.kind === 'blocker-scope')).toEqual([])
  })
})

describe('Lot A — an open extra-scope blocker drives the report bucket', () => {
  it('keeps its target AWAITED while open, and clears it on manual resolve', () => {
    const a = t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    const blk = t.openBlocker({ targetId: a, kind: 'dependency', scope: 'extra', engagementRef: 'eng-1', reason: '' })
    expect(t.report({ baselineCommit: 'c1' }).buckets.AWAITED.map((r) => r.id)).toContain(a)
    t.resolveBlocker(blk)
    expect(t.report({ baselineCommit: 'c1' }).buckets.AWAITED.map((r) => r.id)).not.toContain(a)
  })
})

describe('Lot A — CLI flags', () => {
  it('track item new --accountable/--responsible/--engagement-ref persists them', () => {
    const out: string[] = []
    const io: CliIO = { cwd: dir, out: (s) => out.push(s), err: (s) => out.push(s) }
    expect(runCli(['init'], io)).toBe(0)
    expect(
      runCli(
        ['item', 'new', '--kind', 'feature', '--title', 'X', '--workspace', 'ws', '--accountable', 'human:a', '--responsible', 'agent:c, human:b', '--engagement-ref', 'eng-7'],
        io,
      ),
    ).toBe(0)
    const id = out[out.length - 1]!.trim()
    const item = new Track(new EventStore(join(dir, '.track', 'events.jsonl'))).state().items.get(id)!
    expect(item.accountable).toBe('human:a')
    expect(item.responsible).toEqual(['agent:c', 'human:b'])
    expect(item.engagementRef).toBe('eng-7')
  })
})

// ---- D6-B: first-class decision sponsor = accountable (WP5) ------------------------------------
// v2.3b §8: D6 RESOLVED — the decision's `accountable` IS the sponsor (supersedes the reserved
// separate `sponsor` field, which is dropped). These wire it end-to-end on the DECISION path.

describe('D6-B — decision sponsor (= accountable) surfaced end-to-end', () => {
  const cli = (...argv: string[]): { code: number; out: string } => {
    const out: string[] = []
    const io: CliIO = { cwd: dir, out: (s) => out.push(s), err: (s) => out.push(s) }
    return { code: runCli(argv, io), out: out.join('') }
  }

  it('track decision new --accountable <actor> persists the sponsor', () => {
    expect(cli('init').code).toBe(0)
    const itm = cli('item', 'new', '--kind', 'feature', '--title', 'T', '--workspace', 'ws').out.trim()
    const out = cli('decision', 'new', '--kind', 'orientation', '--title', 'D', '--workspace', 'ws', '--targets', itm, '--accountable', 'human:carol').out
    const decId = out.trim().split('\n').pop()!
    const dec = new Track(new EventStore(eventsPath)).state().decisions.get(decId)!
    expect(dec.accountable).toBe('human:carol')
  })

  it('round-trips through fold + the read contract: report({decisions}) exposes accountable (the sponsor)', () => {
    const itm = t.createItem({ kind: 'feature', title: 'T', workspace: 'ws' })
    const d = t.createDecision({
      decisionKind: 'orientation',
      title: 'D',
      workspace: 'ws',
      targets: [itm],
      dossier: { context: '', options: [], qa: [] },
      accountable: 'human:dave',
    })
    const reader = new TrackReader(eventsPath)
    const row = reader.report({ baselineCommit: 'c1', decisions: true }).decisions!.find((r) => r.id === d)!
    expect(row.accountable).toBe('human:dave')
  })

  it('renders the sponsor in report --decisions text/md (present), and omits it when absent', () => {
    const itm = t.createItem({ kind: 'feature', title: 'T', workspace: 'ws' })
    t.createDecision({ decisionKind: 'orientation', title: 'Sponsored', workspace: 'ws', targets: [itm], dossier: { context: '', options: [], qa: [] }, accountable: 'human:carol' })
    t.createDecision({ decisionKind: 'orientation', title: 'Unsponsored', workspace: 'ws', targets: [itm], dossier: { context: '', options: [], qa: [] } })
    const reader = new TrackReader(eventsPath)
    const text = reportText(reader, { baselineCommit: 'c1', decisions: true }, 'text')
    expect(text).toContain('sponsor:human:carol')
    const sponsoredLine = text.split('\n').find((l) => l.includes('Sponsored') && !l.includes('Unsponsored'))!
    expect(sponsoredLine).toContain('sponsor:human:carol')
    const unsponsoredLine = text.split('\n').find((l) => l.includes('Unsponsored'))!
    expect(unsponsoredLine).not.toContain('sponsor:')
  })

  it('CLI ≡ ingest parity: decision.create carries accountable identically to --accountable', () => {
    const itm = t.createItem({ kind: 'feature', title: 'T', workspace: 'ws' })
    const ctx: IngestContext = { by: 'human:t', workspace: 'ws', prov: { transport: 'import', proposed: false, auth: 'local-user' } }
    const d = ingest(
      [{ v: 1, kind: 'decision.create', payload: { decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [itm], dossier: { context: '', options: [], qa: [] }, accountable: 'human:erin' } }],
      ctx,
      store,
    ).ids[0]!
    expect(t.state().decisions.get(d)!.accountable).toBe('human:erin')
  })

  it('absent --accountable ⇒ undefined (additive, hash-neutral on the decision.created event)', () => {
    const itm = t.createItem({ kind: 'feature', title: 'T', workspace: 'ws' })
    const d = t.createDecision({ decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [itm], dossier: { context: '', options: [], qa: [] } })
    expect(t.state().decisions.get(d)!.accountable).toBeUndefined()
    const createdEvent = store.readAll().find((e) => e.type === 'decision.created')!
    expect('accountable' in (createdEvent.payload as Record<string, unknown>)).toBe(false)
    const reader = new TrackReader(eventsPath)
    const row = reader.report({ baselineCommit: 'c1', decisions: true }).decisions!.find((r) => r.id === d)!
    expect('accountable' in row).toBe(false)
    expect(integral()).toBe(true)
  })
})
