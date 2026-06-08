import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readHead } from './events/head.js'
import { EventStore } from './events/store.js'
import type { Provenance } from './events/types.js'
import { validate } from './events/validate.js'
import type { WorkEventKind } from './ingest/contract.js'
import { ingest, type IngestContext } from './ingest/ingest.js'
import { Track } from './track.js'

// A signed attestation built by a trusted channel (the platform API / h2a bridge) — track RECORDS it.
const SIGNED: Provenance = {
  transport: 'http',
  proposed: false,
  auth: 'signed',
  principal: 'claude:track:abc',
  sig: { alg: 'Ed25519', value: 'c2lnbmF0dXJl', by: 'nhi-key-1' },
}
const WSJF = { userBusinessValue: 1, timeCriticality: 1, riskReductionOpportunityEnablement: 1, jobSize: 2 }

let dir: string
let eventsPath: string
let store: EventStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-m3-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  store = new EventStore(eventsPath)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const integral = (): boolean => validate(store.readAll(), readHead(eventsPath)).ok

describe('M3 (Lot B) — signed provenance is RECORDED (not verified), additive', () => {
  it('round-trips a signed prov (principal + nested sig) on an event, integral', () => {
    new Track(store, { by: 'human:carol', prov: SIGNED }).createItem({ kind: 'feature', title: 'X', workspace: 'ws' })
    const e = store.readAll()[0]!
    expect(e.prov).toEqual(SIGNED)
    expect(integral()).toBe(true) // prov (incl. nested sig) is inside the hashed core and recomputes
  })

  it('snapshots the NESTED sig at construction — mutating the caller sig after cannot vary a batch', () => {
    const live: Provenance = { transport: 'http', proposed: false, auth: 'signed', principal: 'p', sig: { alg: 'Ed25519', value: 'A', by: 'k' } }
    const t = new Track(store, { by: 'human:x', prov: live })
    live.sig!.value = 'TAMPERED' // mutate the caller's nested sig AFTER construction
    const target = t.createItem({ kind: 'feature', title: 'x', workspace: 'ws' })
    t.createDecision({ decisionKind: 'orientation', title: 'd', workspace: 'ws', targets: [target], dossier: { context: '', options: [], qa: [] } })
    for (const e of store.readAll()) expect((e.prov as Provenance).sig!.value).toBe('A') // the construction snapshot, not the mutation
    expect(integral()).toBe(true)
  })

  it('a prov WITHOUT the signed fields hashes identically to a pre-M3 event (canonicalize drops undefined)', () => {
    new Track(store, { by: 'human:x', prov: { transport: 'cli', proposed: false, auth: 'local-user' } }).createItem({ kind: 'feature', title: 'X', workspace: 'ws' })
    const prov = store.readAll()[0]!.prov!
    expect('principal' in prov).toBe(false) // canonicalize dropped the absent keys — no bytes added
    expect('sig' in prov).toBe(false)
    expect(integral()).toBe(true)
  })

  it('a tampered recorded sig is DETECTED — it lives inside the hashed core', () => {
    new Track(store, { by: 'human:x', prov: SIGNED }).createItem({ kind: 'feature', title: 'X', workspace: 'ws' })
    expect(integral()).toBe(true)
    writeFileSync(eventsPath, readFileSync(eventsPath, 'utf8').replace('c2lnbmF0dXJl', 'tampered'))
    const res = validate(store.readAll(), readHead(eventsPath))
    expect(res.ok).toBe(false)
    expect(res.findings.some((f) => f.kind === 'content-hash')).toBe(true) // the attestation is integrity-protected
  })

  it('a mixed log (no-prov + local-user + signed events) all validates together', () => {
    new Track(store, { by: 'human:a' }).createItem({ kind: 'feature', title: 'noprov', workspace: 'ws' })
    new Track(store, { by: 'human:b', prov: { transport: 'cli', proposed: false, auth: 'local-user' } }).createItem({ kind: 'feature', title: 'local', workspace: 'ws' })
    new Track(store, { by: 'human:c', prov: SIGNED }).createItem({ kind: 'feature', title: 'signed', workspace: 'ws' })
    expect(store.readAll().length).toBe(3)
    expect(integral()).toBe(true) // additivity holds at the STREAM level, mixing all three prov shapes
  })
})

describe('M3 (Lot B) — a signed channel may perform BINDING writes via ingest', () => {
  const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({ by: 'human:carol', workspace: 'ws', prov: SIGNED, ...over })
  const ev = (kind: WorkEventKind, payload: Record<string, unknown>) => ({ v: 1 as const, kind, payload })

  it('admits a binding decision.outcome and records auth:signed + principal', () => {
    const item = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
    const dec = ingest(
      [ev('decision.create', { decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [item], dossier: { context: '', options: [], qa: [] } })],
      ctx(),
      store,
    ).ids[0]!
    expect(() => ingest([ev('decision.outcome', { decisionId: dec, to: 'go' })], ctx(), store)).not.toThrow() // 'signed' ∈ BINDING_AUTH
    const outcome = store.readAll().find((e) => e.type === 'decision.outcome')!
    expect((outcome.prov as Provenance).auth).toBe('signed')
    expect((outcome.prov as Provenance).principal).toBe('claude:track:abc')
    expect(integral()).toBe(true)
  })

  it('workspace containment STILL holds for a signed channel (signed is not a bypass)', () => {
    const vItem = ingest([ev('item.create', { kind: 'feature', title: 'V', workspace: 'V' })], ctx({ workspace: 'V' }), store).ids[0]!
    expect(() => ingest([ev('priority.assess', { itemId: vItem, ...WSJF })], ctx({ workspace: 'W' }), store)).toThrow(/belongs to workspace "V"/)
  })
})
