import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { LeaseStore, leasesPathFor, type Lease } from '../lease/store.js'
import { Track } from '../track.js'
import { READ_CONTRACT_VERSION, TrackReader } from './contract.js'

// Demand lifecycle (Mode A, Build 2 — READ 1.13.0) reads: demands() / lifecycleTrace() / the additive
// workspaceActivity demand counters + two new stalled reasons / canevas demand surfacing. PURE/clockless:
// the caller injects `now` (+ leases); abandonment is the reader's call (`now − heartbeatAt > ttlMs`).

const NOW = '2026-06-21T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const DAY = 86_400_000
const OLD = new Date(NOW_MS - 2 * DAY).toISOString() // 2 days back — past the 24h default window

let dir: string
let eventsPath: string
let reader: TrackReader
let seq = 0

/** A Track stamping every event `at = when`, with deterministic ids (`id-NNNN`). */
function trackAt(when: string, over: { leases?: LeaseStore } = {}): Track {
  return new Track(new EventStore(eventsPath), {
    by: 'tester',
    now: () => when,
    newId: () => `id-${String(++seq).padStart(4, '0')}`,
    ...(over.leases !== undefined ? { leases: over.leases } : {}),
  })
}

/** A LeaseStore against the side-store beside the log, stamping `at = when`. */
function leasesAt(when: string): LeaseStore {
  let n = 0
  return new LeaseStore(leasesPathFor(eventsPath), { now: () => when, newId: () => `g-${when}-${String(++n)}` })
}

beforeEach(() => {
  seq = 0
  dir = mkdtempSync(join(tmpdir(), 'track-demand-reads-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  reader = new TrackReader(eventsPath)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('READ 1.15.0 — version pin + surface', () => {
  it('pins READ_CONTRACT_VERSION at 1.17.0 and exposes demands()/lifecycleTrace()', () => {
    expect(READ_CONTRACT_VERSION).toBe('1.17.0')
    const api = reader as unknown as Record<string, unknown>
    expect(typeof api['demands']).toBe('function')
    expect(typeof api['lifecycleTrace']).toBe('function')
  })
})

describe('demands() — shape, affordances, lastHandler', () => {
  it('projects a raised demand with raw/source/affordances and lastHandler', () => {
    const t = trackAt(NOW)
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 'dark mode' }, source: { kind: 'human' }, handler: 'h:raiser' })
    const [view] = reader.demands('W', { now: NOW })
    expect(view).toMatchObject({
      id: d,
      status: 'raised',
      type: 'feature',
      raw: { text: 'dark mode' },
      source: { kind: 'human' },
      lastHandler: 'h:raiser',
      leaseState: 'none',
      affordances: ['demand.claim'],
    })
    expect('currentHandler' in view!).toBe(false) // no lease ⇒ no current handler
  })

  it('lastHandler follows the LATEST demand-axis event (a re-claim updates it)', () => {
    const t = trackAt(NOW)
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 't' }, source: { kind: 'human' }, handler: 'h:raiser' })
    t.claimDemand(d, { handler: 'h:qualifier' })
    const [view] = reader.demands('W', { now: NOW })
    expect(view!.lastHandler).toBe('h:qualifier')
    expect(view!.status).toBe('qualifying')
    expect(view!.affordances).toEqual(['demand.agree', 'demand.disposition'])
  })

  it('is workspace-scoped + surfaces affordances per status (raised/qualifying/parked/terminal)', () => {
    const t = trackAt(NOW)
    const inW = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 'w' }, source: { kind: 'human' }, handler: 'h' })
    t.raiseDemand({ type: 'feature', workspace: 'V', raw: { text: 'v' }, source: { kind: 'human' }, handler: 'h' })
    const parked = t.raiseDemand({ type: 'chore', workspace: 'W', raw: { text: 'p' }, source: { kind: 'human' }, handler: 'h' })
    t.claimDemand(parked, { handler: 'h' })
    t.disposeDemand(parked, { outcome: 'parked', handler: 'h', reason: 'later' })
    const rejected = t.raiseDemand({ type: 'chore', workspace: 'W', raw: { text: 'r' }, source: { kind: 'human' }, handler: 'h' })
    t.claimDemand(rejected, { handler: 'h' })
    t.disposeDemand(rejected, { outcome: 'rejected', handler: 'h', reason: 'no' })

    const views = reader.demands('W', { now: NOW })
    expect(views.map((v) => v.id).sort()).toEqual([inW, parked, rejected].sort())
    expect(views.find((v) => v.id === parked)!.affordances).toEqual(['demand.claim'])
    expect(views.find((v) => v.id === rejected)!.affordances).toEqual([]) // terminal
  })

  it('surfaces itemIds + currentHandler vanishes after promotion if no lease', () => {
    const t = trackAt(NOW)
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 'x' }, source: { kind: 'human' }, handler: 'h' })
    t.claimDemand(d, { handler: 'h' })
    const items = t.agreeDemand(d, { handler: 'h', items: [{ title: 'A' }, { title: 'B' }] })
    const [view] = reader.demands('W', { now: NOW })
    expect(view!.status).toBe('agreed')
    expect(view!.itemIds).toEqual(items)
    expect(view!.affordances).toEqual([])
  })

  it('surfaces duplicateOf on a duplicate disposition', () => {
    const t = trackAt(NOW)
    const survivor = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 's' }, source: { kind: 'human' }, handler: 'h' })
    const dup = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 'd' }, source: { kind: 'human' }, handler: 'h' })
    t.claimDemand(dup, { handler: 'h' })
    t.disposeDemand(dup, { outcome: 'duplicate', handler: 'h', reason: 'same', duplicateOf: { kind: 'demand', id: survivor } })
    const view = reader.demands('W', { now: NOW }).find((v) => v.id === dup)!
    expect(view.status).toBe('duplicate')
    expect(view.duplicateOf).toEqual({ kind: 'demand', id: survivor })
  })
})

describe('demands() — leaseState (none → live → abandoned) + currentHandler', () => {
  it('leaseState live ⇒ currentHandler = the lease holder', () => {
    const t = trackAt(NOW)
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 't' }, source: { kind: 'human' }, handler: 'h:raiser' })
    const lease: Lease = leasesAt(NOW).acquire({ workspace: 'W', subject: { kind: 'demand', id: d }, phase: 'qualifying', holder: 'h:live' })
    const [view] = reader.demands('W', { now: NOW, leases: [lease] })
    expect(view!.leaseState).toBe('live')
    expect(view!.currentHandler).toBe('h:live')
  })

  it('leaseState abandoned ⇒ currentHandler undefined (silent-timeout F1)', () => {
    const t = trackAt(NOW)
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 't' }, source: { kind: 'human' }, handler: 'h:raiser' })
    const lease: Lease = leasesAt(NOW).acquire({ workspace: 'W', subject: { kind: 'demand', id: d }, phase: 'qualifying', holder: 'h:dead', ttlMs: 1_000 })
    const later = new Date(NOW_MS + 10_000).toISOString()
    const [view] = reader.demands('W', { now: later, leases: [lease] })
    expect(view!.leaseState).toBe('abandoned')
    expect('currentHandler' in view!).toBe(false)
  })

  it('reads leases from the side-store when not injected', () => {
    const t = trackAt(NOW)
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 't' }, source: { kind: 'human' }, handler: 'h' })
    leasesAt(NOW).acquire({ workspace: 'W', subject: { kind: 'demand', id: d }, phase: 'qualifying', holder: 'h:side' })
    const [view] = reader.demands('W', { now: NOW }) // no injected leases ⇒ reads .track/leases.json
    expect(view!.leaseState).toBe('live')
    expect(view!.currentHandler).toBe('h:side')
  })
})

describe('lifecycleTrace() — ordered, prov + handler tagged', () => {
  it('orders demand-axis steps by seq with handler + status tags', () => {
    const t = trackAt(NOW)
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 't' }, source: { kind: 'human' }, handler: 'h:raiser' })
    t.claimDemand(d, { handler: 'h:qualifier' })
    t.disposeDemand(d, { outcome: 'rejected', handler: 'h:closer', reason: 'no' })
    const steps = reader.lifecycleTrace({ kind: 'demand', id: d })
    expect(steps.map((s) => [s.kind, s.handler, s.status])).toEqual([
      ['demand.raised', 'h:raiser', 'raised'],
      ['demand.qualifying-started', 'h:qualifier', 'qualifying'],
      ['demand.disposition', 'h:closer', 'rejected'],
    ])
    // strictly seq-ordered
    expect(steps.map((s) => s.seq)).toEqual([...steps.map((s) => s.seq)].sort((a, b) => a - b))
  })

  it('tags origin from prov.proposed (machine vs human)', () => {
    const t = new Track(new EventStore(eventsPath), {
      by: 'sys',
      now: () => NOW,
      newId: () => `id-${String(++seq).padStart(4, '0')}`,
      prov: { transport: 'mcp-stdio', proposed: true, auth: 'signed', principal: 'claude:track:1' },
    })
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 't' }, source: { kind: 'human' }, handler: 'h' })
    const [step] = reader.lifecycleTrace({ kind: 'demand', id: d })
    expect(step!.origin).toBe('machine')
    expect(step!.prov).toMatchObject({ proposed: true, auth: 'signed', principal: 'claude:track:1' })
  })

  it('for an ITEM: surfaces the DURABLE spec.abandoned (explicit abandon, distinct from a silent timeout)', () => {
    const t = trackAt(NOW)
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 't' }, source: { kind: 'human' }, handler: 'h' })
    t.claimDemand(d, { handler: 'h' })
    const [item] = t.agreeDemand(d, { handler: 'h', items: [{ title: 'A' }] })
    t.startSpec(item!, { handler: 'h:spec' })
    t.abandonSpec(item!, { handler: 'h:spec', reason: 'blocked' })
    const steps = reader.lifecycleTrace({ kind: 'item', id: item! })
    const kinds = steps.map((s) => s.kind)
    expect(kinds).toContain('item.created')
    expect(kinds).toContain('spec.started')
    expect(kinds).toContain('spec.abandoned') // the DURABLE explicit-abandon fact (F1)
    const abandon = steps.find((s) => s.kind === 'spec.abandoned')!
    expect(abandon.handler).toBe('h:spec')
  })
})

describe('workspaceActivity — additive demand counters', () => {
  it('counts raised/qualifying/agreed; absent when the workspace has no demands', () => {
    const t = trackAt(NOW)
    t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 'a' }, source: { kind: 'human' }, handler: 'h' })
    const q = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 'b' }, source: { kind: 'human' }, handler: 'h' })
    t.claimDemand(q, { handler: 'h' })
    const ag = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 'c' }, source: { kind: 'human' }, handler: 'h' })
    t.claimDemand(ag, { handler: 'h' })
    t.agreeDemand(ag, { handler: 'h', items: [{ title: 'X' }] })

    const act = reader.workspaceActivity('W', { baselineCommit: 'HEAD', now: NOW })
    expect(act.demands).toEqual({ raised: 1, qualifying: 1, agreed: 1 })

    const empty = reader.workspaceActivity('NO-DEMANDS', { baselineCommit: 'HEAD', now: NOW })
    expect('demands' in empty).toBe(false) // additive — absent when no demands in the workspace
  })
})

describe('workspaceActivity — the two new demand-axis stalled reasons', () => {
  it('demand-unqualified-idle: a qualifying demand with an ABANDONED lease + idle latest event', () => {
    const t = trackAt(OLD) // the demand events are 2 days old ⇒ predate the window
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 'stale', title: 'Stale demand' }, source: { kind: 'human' }, handler: 'h' })
    t.claimDemand(d, { handler: 'h' })
    const lease: Lease = leasesAt(OLD).acquire({ workspace: 'W', subject: { kind: 'demand', id: d }, phase: 'qualifying', holder: 'h:dead', ttlMs: 1_000 })

    const act = reader.workspaceActivity('W', { baselineCommit: 'HEAD', now: NOW, leases: [lease] })
    const stuck = act.stalled.find((s) => s.id === d)!
    expect(stuck).toMatchObject({ reason: 'demand-unqualified-idle', title: 'Stale demand' })
  })

  it('does NOT flag a qualifying demand whose lease is still LIVE', () => {
    const t = trackAt(OLD)
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 'live' }, source: { kind: 'human' }, handler: 'h' })
    t.claimDemand(d, { handler: 'h' })
    // a lease heartbeat AT now ⇒ live (never abandoned vs NOW)
    const lease: Lease = leasesAt(NOW).acquire({ workspace: 'W', subject: { kind: 'demand', id: d }, phase: 'qualifying', holder: 'h:live' })
    const act = reader.workspaceActivity('W', { baselineCommit: 'HEAD', now: NOW, leases: [lease] })
    expect(act.stalled.find((s) => s.id === d)).toBeUndefined()
  })

  it('spec-abandoned-idle: an agreed item with an ABANDONED spec-lease (idle)', () => {
    const t = trackAt(OLD)
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 'x' }, source: { kind: 'human' }, handler: 'h' })
    t.claimDemand(d, { handler: 'h' })
    const [item] = t.agreeDemand(d, { handler: 'h', items: [{ title: 'Promoted item' }] })
    // a spec lease whose heartbeat is 2 days old ⇒ abandoned + idle vs NOW
    const lease: Lease = leasesAt(OLD).acquire({ workspace: 'W', subject: { kind: 'item', id: item! }, phase: 'specifying', holder: 'h:dead', ttlMs: 1_000 })

    const act = reader.workspaceActivity('W', { baselineCommit: 'HEAD', now: NOW, leases: [lease] })
    const stuck = act.stalled.find((s) => s.id === item)!
    expect(stuck).toMatchObject({ reason: 'spec-abandoned-idle', title: 'Promoted item', since: lease.heartbeatAt })
  })

  it('does NOT overload the existing stalled reasons (an item with no abandoned spec-lease is not spec-abandoned-idle)', () => {
    const t = trackAt(OLD)
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 'x' }, source: { kind: 'human' }, handler: 'h' })
    t.claimDemand(d, { handler: 'h' })
    const [item] = t.agreeDemand(d, { handler: 'h', items: [{ title: 'P' }] })
    // no spec lease at all ⇒ the promoted (to-do) item is the existing todo-idle reason, NOT spec-abandoned-idle
    const act = reader.workspaceActivity('W', { baselineCommit: 'HEAD', now: NOW, leases: [] })
    const stuck = act.stalled.find((s) => s.id === item)!
    expect(stuck.reason).toBe('todo-idle')
  })
})

describe('canevas — surfaces demands + demand affordances', () => {
  it('adds demand prov-lineage + affordances entries keyed on the demand aggregateId', () => {
    const t = trackAt(NOW)
    const d = t.raiseDemand({ type: 'feature', workspace: 'W', raw: { text: 'cv' }, source: { kind: 'human' }, handler: 'h' })
    t.claimDemand(d, { handler: 'h' })
    const view = reader.canevas('W', { baselineCommit: 'HEAD' })
    expect(view.affordances[d]).toEqual(['demand.agree', 'demand.disposition'])
    expect(view.prov[d]).toBeDefined()
    expect(view.prov[d]!.latestAt).toBe(NOW)
  })

  it('is workspace-scoped: a V-workspace demand does not appear under W', () => {
    const t = trackAt(NOW)
    const v = t.raiseDemand({ type: 'feature', workspace: 'V', raw: { text: 'v' }, source: { kind: 'human' }, handler: 'h' })
    const view = reader.canevas('W', { baselineCommit: 'HEAD' })
    expect(view.affordances[v]).toBeUndefined()
  })
})
