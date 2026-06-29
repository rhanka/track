// Demand lifecycle (Mode A) — the ingest write path: new WorkEvent kinds route through the facade under
// channel authorization. `demand.raise` is non-binding (any channel); claim/agree/disposition/spec.* are
// BINDING (require auth ∈ {local-user, signed}). Mirrors src/ingest/seam-v0.test.ts patterns.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import type { Provenance, Ulid } from '../events/types.js'
import { fold } from '../state/fold.js'
import { INGEST_CONTRACT_VERSION } from './contract.js'
import type { WorkEvent, WorkEventKind } from './contract.js'
import { ingest, type IngestContext } from './ingest.js'

const now = (): string => '2026-06-21T00:00:00.000Z'
const counter = (): (() => Ulid) => {
  let i = 0
  return () => `id-${String(++i).padStart(4, '0')}`
}
const SIGNED: Provenance = { transport: 'import', proposed: false, auth: 'signed' }
const LOCAL: Provenance = { transport: 'import', proposed: false, auth: 'local-user' }
const UNAUTH: Provenance = { transport: 'cli', proposed: false, auth: 'unauthenticated' }
const ev = (kind: WorkEventKind, payload: Record<string, unknown>): WorkEvent => ({ v: 1, kind, payload })

let dir: string
let n = 0
const freshStore = (): EventStore => new EventStore(join(dir, `s${++n}`, '.track', 'events.jsonl'))
const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({ by: 'h2a:t', workspace: 'ws', prov: SIGNED, ...over })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-demand-ingest-'))
  n = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const RAISE = { type: 'feature', raw: { text: 'add X' }, source: { kind: 'human' }, handler: 'h:raise', workspace: 'ws' }

describe('demand ingest — contract version bump (additive minor)', () => {
  it('INGEST_CONTRACT_VERSION bumped 1.2.0 → 1.3.0 (demand lifecycle additive kinds)', () => {
    expect(INGEST_CONTRACT_VERSION).toBe('1.4.0') // bumped again to 1.4.0 by cross-workspace WP reorg (item.restructure)
  })
})

describe('demand ingest — demand.raise is NON-binding (any channel may capture)', () => {
  it('an UNAUTHENTICATED channel may raise a demand (the "nothing untracked" guarantee)', () => {
    const store = freshStore()
    const res = ingest([ev('demand.raise', RAISE)], ctx({ newId: counter(), now, prov: UNAUTH }), store)
    const d = res.ids[0]!
    expect(fold(store.readAll()).demands.get(d)).toMatchObject({ status: 'raised', type: 'feature' })
  })

  it('the raise contains the channel workspace and the handler', () => {
    const store = freshStore()
    const d = ingest([ev('demand.raise', RAISE)], ctx({ newId: counter(), now, prov: UNAUTH }), store).ids[0]!
    const demand = fold(store.readAll()).demands.get(d)!
    expect(demand.workspace).toBe('ws')
    const raised = store.readAll().find((e) => e.type === 'demand.raised')!
    expect((raised.payload as { handler: string }).handler).toBe('h:raise')
  })
})

describe('demand ingest — claim/agree/disposition/spec are BINDING (need auth)', () => {
  it('binding deny fires on demand.claim from an unauthenticated channel', () => {
    const store = freshStore()
    const d = ingest([ev('demand.raise', RAISE)], ctx({ newId: counter(), now, prov: UNAUTH }), store).ids[0]!
    expect(() =>
      ingest([ev('demand.claim', { demandId: d, handler: 'h:q' })], ctx({ prov: UNAUTH }), store),
    ).toThrow(/binding/i)
  })

  it('a signed channel drives the full lifecycle raise → claim → agree (atomic promotion)', () => {
    const store = freshStore()
    const c = counter()
    const d = ingest([ev('demand.raise', { ...RAISE, type: 'defect' })], ctx({ newId: c, now, prov: SIGNED }), store).ids[0]!
    ingest([ev('demand.claim', { demandId: d, handler: 'h:q' })], ctx({ newId: c, now, prov: SIGNED }), store)
    ingest([ev('demand.agree', { demandId: d, handler: 'h:a', items: [{ title: 'fix' }] })], ctx({ newId: c, now, prov: SIGNED }), store)
    const state = fold(store.readAll())
    const demand = state.demands.get(d)!
    expect(demand.status).toBe('agreed')
    expect(demand.itemIds).toHaveLength(1)
    const item = state.items.get(demand.itemIds![0]!)!
    expect(item.kind).toBe('defect')
    expect(item.demandId).toBe(d)
  })

  it('routes demand.disposition (rejected) through the facade', () => {
    const store = freshStore()
    const c = counter()
    const d = ingest([ev('demand.raise', RAISE)], ctx({ newId: c, now, prov: LOCAL }), store).ids[0]!
    ingest([ev('demand.claim', { demandId: d, handler: 'h' })], ctx({ newId: c, now, prov: LOCAL }), store)
    ingest([ev('demand.disposition', { demandId: d, outcome: 'rejected', handler: 'h', reason: 'no' })], ctx({ newId: c, now, prov: LOCAL }), store)
    expect(fold(store.readAll()).demands.get(d)!.status).toBe('rejected')
  })

  it('routes spec.claim / spec.abandon through the facade', () => {
    const store = freshStore()
    const c = counter()
    const d = ingest([ev('demand.raise', RAISE)], ctx({ newId: c, now, prov: LOCAL }), store).ids[0]!
    ingest([ev('demand.claim', { demandId: d, handler: 'h' })], ctx({ newId: c, now, prov: LOCAL }), store)
    ingest([ev('demand.agree', { demandId: d, handler: 'h', items: [{ title: 'work' }] })], ctx({ newId: c, now, prov: LOCAL }), store)
    const itemId = fold(store.readAll()).demands.get(d)!.itemIds![0]!
    ingest([ev('spec.claim', { itemId, handler: 'h:spec' })], ctx({ prov: LOCAL }), store)
    ingest([ev('spec.abandon', { itemId, handler: 'h:spec', reason: 'ctx out' })], ctx({ prov: LOCAL }), store)
    const types = store.readAll().map((e) => e.type)
    expect(types).toContain('spec.started')
    expect(types).toContain('spec.abandoned')
  })
})

describe('demand ingest — workspace containment', () => {
  it('a W-pinned channel cannot claim a demand raised in V', () => {
    const store = freshStore()
    const c = counter()
    const d = ingest([ev('demand.raise', { ...RAISE, workspace: 'V' })], ctx({ newId: c, now, prov: LOCAL, workspace: 'V' }), store).ids[0]!
    expect(() =>
      ingest([ev('demand.claim', { demandId: d, handler: 'h' })], ctx({ prov: LOCAL, workspace: 'W' }), store),
    ).toThrow(/workspace/i)
  })

  it('demand.raise payload.workspace must equal the channel workspace', () => {
    const store = freshStore()
    expect(() =>
      ingest([ev('demand.raise', { ...RAISE, workspace: 'OTHER' })], ctx({ newId: counter(), now, prov: LOCAL, workspace: 'ws' }), store),
    ).toThrow(/workspace/i)
  })
})

describe('demand ingest — fail-closed schema', () => {
  it('rejects an unknown payload field on demand.raise', () => {
    const store = freshStore()
    expect(() =>
      ingest([ev('demand.raise', { ...RAISE, bogus: 1 })], ctx({ newId: counter(), now, prov: LOCAL }), store),
    ).toThrow()
  })

  it('rejects a missing required field (demand.disposition without outcome)', () => {
    const store = freshStore()
    const c = counter()
    const d = ingest([ev('demand.raise', RAISE)], ctx({ newId: c, now, prov: LOCAL }), store).ids[0]!
    ingest([ev('demand.claim', { demandId: d, handler: 'h' })], ctx({ newId: c, now, prov: LOCAL }), store)
    expect(() =>
      ingest([ev('demand.disposition', { demandId: d, handler: 'h', reason: 'x' })], ctx({ prov: LOCAL }), store),
    ).toThrow()
  })
})
