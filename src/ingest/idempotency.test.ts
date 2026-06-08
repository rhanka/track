import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readHead } from '../events/head.js'
import { EventStore } from '../events/store.js'
import type { Provenance } from '../events/types.js'
import { validate } from '../events/validate.js'
import type { WorkEvent, WorkEventKind } from './contract.js'
import { ingest, type IngestContext } from './ingest.js'

const PROV: Provenance = { transport: 'import', proposed: false, auth: 'local-user' }
const WSJF = { userBusinessValue: 1, timeCriticality: 1, riskReductionOpportunityEnablement: 1, jobSize: 2 }
const ev = (kind: WorkEventKind, payload: Record<string, unknown>, clientToken?: string): WorkEvent => ({
  v: 1,
  kind,
  payload,
  ...(clientToken !== undefined ? { clientToken } : {}),
})

let dir: string
let n = 0
const pathFor = (): string => join(dir, `s${++n}`, '.track', 'events.jsonl')
const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({ by: 'human:t', workspace: 'ws', prov: PROV, ...over })
const created = (path: string): number => new EventStore(path).readAll().filter((e) => e.type === 'item.created').length

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-idem-'))
  n = 0
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ingest idempotency — clientToken skip with stable ids', () => {
  it('re-ingesting a tokened stream is a no-op and returns the SAME ids', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const stream = [ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }, 't-1')]
    const r1 = ingest(stream, ctx(), store)
    const after1 = store.readAll().length
    const r2 = ingest(stream, ctx(), store)
    expect(store.readAll().length).toBe(after1) // nothing re-applied
    expect(r2.ids).toEqual(r1.ids) // stable id on skip
  })

  it('an UNtokened stream still re-applies on re-ingest (at-least-once preserved)', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const stream = [ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })] // no token
    ingest(stream, ctx(), store)
    ingest(stream, ctx(), store)
    expect(created(path)).toBe(2)
  })

  it('skips a tokened transition replay instead of throwing "illegal transition"', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
    const spec = [ev('item.spec', { itemId, to: 'specified' }, 'spec-1')]
    ingest(spec, ctx(), store)
    // Without the token this would throw `specified -> specified`; the token makes the retry never reach the machine.
    expect(() => ingest(spec, ctx(), store)).not.toThrow()
    expect(store.readAll().filter((e) => e.type === 'spec.transition').length).toBe(1)
  })

  it('prevents duplicate criterion + priority on a tokened retry, with stable ids', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
    const stream = [
      ev('acceptance.criterion', { itemId, statement: 's' }, 'crit-1'),
      ev('priority.assess', { itemId, ...WSJF }, 'pri-1'),
    ]
    const r1 = ingest(stream, ctx(), store)
    const r2 = ingest(stream, ctx(), store)
    expect(store.readAll().filter((e) => e.type === 'acceptance.criterion.added').length).toBe(1)
    expect(store.readAll().filter((e) => e.type === 'priority.assessed').length).toBe(1)
    expect(r2.ids).toEqual(r1.ids) // criterion id + the null for assess both stable
  })

  it('a retry skips the committed prefix and applies only the new suffix (resume-after-partial)', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }, 'c-2')], ctx(), store).ids[0]!
    ingest([ev('item.spec', { itemId, to: 'specified' }, 's-2')], ctx(), store)
    const before = store.readAll().length
    const r = ingest(
      [
        ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }, 'c-2'), // skip
        ev('item.spec', { itemId, to: 'specified' }, 's-2'), // skip
        ev('item.realize', { itemId, to: 'in-progress' }, 'rz-2'), // NEW → apply
      ],
      ctx(),
      store,
    )
    expect(r.ids[0]).toBe(itemId) // stable id for the skipped create
    expect(store.readAll().length).toBe(before + 1) // only the new realize appended
  })

  it('also skips an intra-stream duplicate token (same token twice in one file)', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const r = ingest(
      [
        ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }, 'dup'),
        ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }, 'dup'), // same token → skip
      ],
      ctx(),
      store,
    )
    expect(created(path)).toBe(1)
    expect(r.ids[0]).toBe(r.ids[1]) // the duplicate returns the first's id
  })

  it('a tampered clientToken is detected (it is hash-covered)', () => {
    const path = pathFor()
    const store = new EventStore(path)
    ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }, 'tok-x')], ctx(), store)
    expect(validate(store.readAll(), readHead(path)).ok).toBe(true)
    writeFileSync(path, readFileSync(path, 'utf8').replace('tok-x', 'tok-Y'))
    expect(validate(store.readAll(), readHead(path)).ok).toBe(false) // contentHash no longer matches
  })

  it('mixes tokened and untokened events; re-ingest re-applies only the untokened', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const stream = [
      ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }), // untokened
      ev('item.create', { kind: 'bug', title: 'B', workspace: 'ws' }, 'b-1'), // tokened
    ]
    ingest(stream, ctx(), store)
    expect(validate(store.readAll(), readHead(path)).ok).toBe(true)
    ingest(stream, ctx(), store)
    expect(created(path)).toBe(3) // untokened re-applied (2), tokened skipped (still 1)
  })

  it('skips a tokened decision.create batch WHOLESALE on retry, returning the decisionId', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
    const dstream = [
      ev('decision.create', { decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [itemId], dossier: { context: '', options: [], qa: [] } }, 'dec-1'),
    ]
    const r1 = ingest(dstream, ctx(), store)
    const after1 = store.readAll().length // decision.created + 1 blocker.opened
    const r2 = ingest(dstream, ctx(), store)
    expect(store.readAll().length).toBe(after1) // the whole cmdId batch skipped
    expect(r2.ids).toEqual(r1.ids) // returns the decisionId
  })

  it('skips a tokened no-go outcome batch on retry (no illegal-transition throw)', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
    const decId = ingest(
      [ev('decision.create', { decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [itemId], dossier: { context: '', options: [], qa: [] } })],
      ctx(),
      store,
    ).ids[0]!
    const out = [ev('decision.outcome', { decisionId: decId, to: 'no-go' }, 'out-1')]
    ingest(out, ctx(), store)
    const after = store.readAll().length // outcome + blocker.resolved + realization→rejected
    expect(() => ingest(out, ctx(), store)).not.toThrow() // otherwise: illegal outcome transition (already no-go)
    expect(store.readAll().length).toBe(after)
  })

  it('returns stable ids for tokened blocker.raise and acceptance.link retries', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
    const critId = ingest([ev('acceptance.criterion', { itemId, statement: 's' })], ctx(), store).ids[0]!
    const stream = [
      ev('acceptance.link', { criterionId: critId, kind: 'unit', locator: 'l' }, 'lnk-1'), // resultIdOf reads payload.evidenceId
      ev('blocker.raise', { targetId: itemId, kind: 'dependency', ref: itemId }, 'blk-1'), // resultIdOf reads aggregateId
    ]
    const r1 = ingest(stream, ctx(), store)
    const after1 = store.readAll().length
    const r2 = ingest(stream, ctx(), store)
    expect(store.readAll().length).toBe(after1) // both skipped
    expect(r2.ids).toEqual(r1.ids) // evidenceId + blockerId both stable
    expect(r2.ids.every((x) => x !== null)).toBe(true)
  })

  it('scopes tokens PER WORKSPACE — a colliding token from another workspace does NOT suppress the write', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const vId = ingest([ev('item.create', { kind: 'feature', title: 'V', workspace: 'V' }, 'shared')], ctx({ workspace: 'V' }), store).ids[0]!
    const before = created(path)
    const r = ingest([ev('item.create', { kind: 'feature', title: 'W', workspace: 'W' }, 'shared')], ctx({ workspace: 'W' }), store)
    expect(created(path)).toBe(before + 1) // the W write is NOT suppressed by V's identical token
    expect(r.ids[0]).not.toBe(vId) // and returns W's own new id, not V's
  })
})
