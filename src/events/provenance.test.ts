import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readHead } from './head.js'
import { EventStore } from './store.js'
import type { Provenance } from './types.js'
import { validate } from './validate.js'
import { Track } from '../track.js'

const PROV: Provenance = { transport: 'cli', proposed: false, auth: 'local-user' }

let dir: string
let eventsPath: string

function track(opts: { prov?: Provenance } = {}): Track {
  let n = 0
  return new Track(new EventStore(eventsPath), {
    by: 'human:tester',
    now: () => '2026-06-05T10:00:00.000Z',
    newId: () => `id-${String(++n).padStart(4, '0')}`,
    ...(opts.prov !== undefined ? { prov: opts.prov } : {}),
  })
}

const events = () => new EventStore(eventsPath).readAll()
const integ = () => validate(events(), readHead(eventsPath))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-prov-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('provenance (D3) — stamped, hash-covered, additive', () => {
  it('stamps prov + actor on emitted events and stays integral', () => {
    const t = track({ prov: PROV })
    t.createItem({ kind: 'feature', title: 'x', workspace: 'ws' })
    const e = events()[0]!
    expect(e.by).toBe('human:tester')
    expect(e.prov).toEqual(PROV)
    expect(integ().ok).toBe(true) // prov is inside the hashed core, recomputes consistently
  })

  it('omits the prov field entirely when not configured (backward-compatible)', () => {
    track().createItem({ kind: 'feature', title: 'x', workspace: 'ws' })
    const e = events()[0]!
    expect('prov' in e).toBe(false) // absent key — pre-D3 events hash identically
    expect(integ().ok).toBe(true)
  })

  it('A4: tampering prov is detected (it is part of contentHash)', () => {
    track({ prov: PROV }).createItem({ kind: 'feature', title: 'x', workspace: 'ws' })
    expect(integ().ok).toBe(true)
    const raw = readFileSync(eventsPath, 'utf8')
    writeFileSync(eventsPath, raw.replace('"auth":"local-user"', '"auth":"tampered"'))
    expect(integ().ok).toBe(false) // contentHash no longer matches the tampered core
  })

  it('snapshots prov at construction — a mutated/live prov cannot vary across a batch', () => {
    const live: Provenance = { transport: 'cli', proposed: false, auth: 'local-user' }
    let n = 0
    const t = new Track(new EventStore(eventsPath), {
      by: 'human:x',
      now: () => '2026-06-05T10:00:00.000Z',
      newId: () => `id-${String(++n).padStart(4, '0')}`,
      prov: live,
    })
    live.auth = 'unauthenticated' // mutate the caller's object AFTER construction
    const target = t.createItem({ kind: 'feature', title: 'x', workspace: 'ws' })
    t.createDecision({ decisionKind: 'orientation', title: 'd', workspace: 'ws', targets: [target], dossier: { context: '', options: [], qa: [] } })
    // every emitted event carries the SNAPSHOT taken at construction, not the later mutation
    for (const e of events()) expect(e.prov?.auth).toBe('local-user')
    expect(integ().ok).toBe(true)
  })

  it('stamps prov on EVERY member of a multi-event cmdId batch', () => {
    const t = track({ prov: PROV })
    const target = t.createItem({ kind: 'feature', title: 'x', workspace: 'ws' })
    t.createDecision({ decisionKind: 'orientation', title: 'd', workspace: 'ws', targets: [target], dossier: { context: '', options: [], qa: [] } })
    const batch = events().filter((e) => e.type === 'decision.created' || e.type === 'blocker.opened')
    expect(batch.length).toBeGreaterThan(1)
    for (const e of batch) expect(e.prov).toEqual(PROV)
    expect(integ().ok).toBe(true)
  })

  it('validates a log that MIXES prov and non-prov events', () => {
    track({ prov: PROV }).createItem({ kind: 'feature', title: 'a', workspace: 'ws' }) // with prov
    track().createItem({ kind: 'feature', title: 'b', workspace: 'ws' }) // no prov, same store
    const es = events()
    expect(es.some((e) => e.prov !== undefined)).toBe(true)
    expect(es.some((e) => !('prov' in e))).toBe(true)
    expect(integ().ok).toBe(true)
  })

  it('stamps prov on branch-import events', () => {
    const fixture = '# Feature: BR-7 — Demo\n\n## Plan / Todo\n- [x] **Lot 0 — Scaffold**\n'
    track({ prov: PROV }).importBranch(fixture, { locator: 'plan/7.md', commit: 'c1' })
    const es = events()
    expect(es.length).toBeGreaterThan(0)
    for (const e of es) expect(e.prov).toEqual(PROV)
    expect(integ().ok).toBe(true)
  })
})
