import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { computeHash } from './events/canonical.js'
import { stripFrame } from './events/frame.js'
import { EventStore } from './events/store.js'
import type { Provenance, TrackEvent, Ulid } from './events/types.js'
import { validate } from './events/validate.js'
import { fold } from './state/fold.js'
import { Track } from './track.js'

let dir: string
let store: EventStore
let track: Track

const NOW = '2026-06-21T10:00:00.000Z'

function freshTrack(over: { by?: string; prov?: Provenance } = {}): Track {
  let n = 0
  return new Track(store, {
    by: over.by ?? 'tester',
    now: () => NOW,
    newId: () => `id-${String(++n).padStart(4, '0')}`,
    ...(over.prov !== undefined ? { prov: over.prov } : {}),
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-demand-'))
  store = new EventStore(join(dir, '.track', 'events.jsonl'))
  track = freshTrack()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const raw = { text: 'add dark mode' }
const source = { kind: 'human' as const }

function raise(over: Record<string, unknown> = {}): string {
  return track.raiseDemand({ type: 'feature', raw, source, handler: 'h:raiser', ...over } as Parameters<Track['raiseDemand']>[0])
}

describe('raiseDemand → demand.raised (the durable capture)', () => {
  it('creates a demand in status raised with the immutable t=0 capture + source + handler', () => {
    const d = raise()
    const demand = track.state().demands.get(d)!
    expect(demand).toMatchObject({
      id: d,
      workspace: 'ws',
      type: 'feature',
      raw: { text: 'add dark mode' },
      source: { kind: 'human' },
      status: 'raised',
    })
    expect(validate(store.readAll()).ok).toBe(true)
    const ev = store.readAll().find((e) => e.type === 'demand.raised')!
    expect(ev.aggregate).toBe('demand')
    expect((ev.payload as { handler: string }).handler).toBe('h:raiser')
  })

  it('requires a workspace and carries it onto the demand', () => {
    const d = track.raiseDemand({ type: 'feature', workspace: 'shop', raw, source, handler: 'h' })
    expect(track.state().demands.get(d)!.workspace).toBe('shop')
  })

  it('rejects an invalid type fail-closed (frozen contract: validate the payload)', () => {
    expect(() => track.raiseDemand({ type: 'epic' as never, raw, source, handler: 'h' })).toThrow()
  })
})

describe('claimDemand → demand.qualifying-started (raised|parked → qualifying)', () => {
  it('moves raised → qualifying and records the handler', () => {
    const d = raise()
    track.claimDemand(d, { handler: 'h:qualifier' })
    expect(track.state().demands.get(d)!.status).toBe('qualifying')
    const ev = store.readAll().find((e) => e.type === 'demand.qualifying-started')!
    expect((ev.payload as { handler: string }).handler).toBe('h:qualifier')
  })

  it('rejects claiming an already-qualifying demand (illegal transition at append)', () => {
    const d = raise()
    track.claimDemand(d, { handler: 'h' })
    expect(() => track.claimDemand(d, { handler: 'h' })).toThrow(/illegal demand transition/)
  })

  it('allows re-claiming a parked demand (parked → qualifying re-entrant)', () => {
    const d = raise()
    track.claimDemand(d, { handler: 'h' })
    track.disposeDemand(d, { outcome: 'parked', handler: 'h', reason: 'later' })
    expect(() => track.claimDemand(d, { handler: 'h2' })).not.toThrow()
    expect(track.state().demands.get(d)!.status).toBe('qualifying')
  })

  it('rejects claiming an unknown demand', () => {
    expect(() => track.claimDemand('nope', { handler: 'h' })).toThrow(/unknown demand/)
  })
})

describe('agreeDemand → ATOMIC promotion (demand.agreed + item.created in ONE cmdId batch)', () => {
  it('emits demand.agreed + ONE item.created as one batch; the item back-links demandId + kind=type', () => {
    const d = raise({ type: 'defect' })
    track.claimDemand(d, { handler: 'h' })
    const itemIds = track.agreeDemand(d, { handler: 'h:agreer', items: [{ title: 'fix the bug' }] })
    expect(itemIds).toHaveLength(1)

    const events = store.readAll()
    const agreed = events.find((e) => e.type === 'demand.agreed')!
    const created = events.find((e) => e.type === 'item.created')!
    // ONE atomic cmdId batch (mirrors createDecision's decision.created+blocker batch)
    expect(agreed.cmdId).toBeDefined()
    expect(created.cmdId).toBe(agreed.cmdId)
    expect(agreed.cmd).toEqual({ i: 0, n: 2 })
    expect(created.cmd).toEqual({ i: 1, n: 2 })

    const item = track.state().items.get(itemIds[0]!)!
    expect(item.kind).toBe('defect') // type carried to item kind
    expect(item.demandId).toBe(d) // back-link
    expect(item.title).toBe('fix the bug')

    const demand = track.state().demands.get(d)!
    expect(demand.status).toBe('agreed')
    expect(demand.itemIds).toEqual(itemIds)
    expect(validate(events).ok).toBe(true)
  })

  it('supports 1..N items (fan-out): demand.agreed + N item.created in one batch', () => {
    const d = raise()
    track.claimDemand(d, { handler: 'h' })
    const itemIds = track.agreeDemand(d, {
      handler: 'h',
      items: [{ title: 'part A' }, { title: 'part B' }, { title: 'part C' }],
    })
    expect(itemIds).toHaveLength(3)
    const created = store.readAll().filter((e) => e.type === 'item.created')
    expect(created).toHaveLength(3)
    // all share the demand.agreed cmdId, batch size n=4
    const cmdId = store.readAll().find((e) => e.type === 'demand.agreed')!.cmdId
    expect(created.every((e) => e.cmdId === cmdId && e.cmd!.n === 4)).toBe(true)
    expect(track.state().demands.get(d)!.itemIds).toEqual(itemIds)
    for (const id of itemIds) expect(track.state().items.get(id)!.demandId).toBe(d)
  })

  it('rejects agreeing a demand that is not qualifying (must claim first)', () => {
    const d = raise()
    expect(() => track.agreeDemand(d, { handler: 'h', items: [{ title: 'x' }] })).toThrow(/illegal demand transition/)
  })

  it('rejects agreeing with zero items (a promotion must yield ≥1 item)', () => {
    const d = raise()
    track.claimDemand(d, { handler: 'h' })
    expect(() => track.agreeDemand(d, { handler: 'h', items: [] })).toThrow()
  })

  it('promotes the demand kind=type to the item, defaulting kind from the demand type', () => {
    const d = raise({ type: 'chore' })
    track.claimDemand(d, { handler: 'h' })
    const [id] = track.agreeDemand(d, { handler: 'h', items: [{ title: 'a chore' }] })
    expect(track.state().items.get(id!)!.kind).toBe('chore')
  })
})

describe('disposeDemand → demand.disposition (rejected|duplicate|parked, qualifying off-ramp)', () => {
  it('rejects a demand (qualifying → rejected, records reason + handler)', () => {
    const d = raise()
    track.claimDemand(d, { handler: 'h' })
    track.disposeDemand(d, { outcome: 'rejected', handler: 'h:dec', reason: 'out of scope' })
    const demand = track.state().demands.get(d)!
    expect(demand.status).toBe('rejected')
    expect(demand.rejectReason).toBe('out of scope')
    const ev = store.readAll().find((e) => e.type === 'demand.disposition')!
    expect((ev.payload as { handler: string }).handler).toBe('h:dec')
  })

  it('parks a demand (records parkReason; remains re-claimable)', () => {
    const d = raise()
    track.claimDemand(d, { handler: 'h' })
    track.disposeDemand(d, { outcome: 'parked', handler: 'h', reason: 'blocked on Q' })
    expect(track.state().demands.get(d)!.status).toBe('parked')
    expect(track.state().demands.get(d)!.parkReason).toBe('blocked on Q')
  })

  it('records a duplicate with a same-workspace, non-self duplicateOf demand', () => {
    const survivor = raise()
    const dup = raise()
    track.claimDemand(dup, { handler: 'h' })
    track.disposeDemand(dup, { outcome: 'duplicate', handler: 'h', reason: 'dup of survivor', duplicateOf: { kind: 'demand', id: survivor } })
    const demand = track.state().demands.get(dup)!
    expect(demand.status).toBe('duplicate')
    expect(demand.duplicateOf).toEqual({ kind: 'demand', id: survivor })
  })

  it('rejects a duplicate that points at ITSELF (non-self containment)', () => {
    const d = raise()
    track.claimDemand(d, { handler: 'h' })
    expect(() =>
      track.disposeDemand(d, { outcome: 'duplicate', handler: 'h', reason: 'x', duplicateOf: { kind: 'demand', id: d } }),
    ).toThrow(/itself|non-self|same/i)
  })

  it('rejects a duplicate whose survivor is in ANOTHER workspace (same-workspace containment)', () => {
    const otherWs = track.raiseDemand({ type: 'feature', workspace: 'OTHER', raw, source, handler: 'h' })
    const d = raise() // workspace 'ws'
    track.claimDemand(d, { handler: 'h' })
    expect(() =>
      track.disposeDemand(d, { outcome: 'duplicate', handler: 'h', reason: 'x', duplicateOf: { kind: 'demand', id: otherWs } }),
    ).toThrow(/workspace/i)
  })

  it('rejects a disposition on a demand that is not qualifying', () => {
    const d = raise() // still raised
    expect(() => track.disposeDemand(d, { outcome: 'rejected', handler: 'h', reason: 'x' })).toThrow(/illegal demand transition/)
  })

  it('rejects an unknown disposition outcome (e.g. agreed) fail-closed', () => {
    const d = raise()
    track.claimDemand(d, { handler: 'h' })
    expect(() => track.disposeDemand(d, { outcome: 'agreed' as never, handler: 'h', reason: 'x' })).toThrow()
  })
})

describe('startSpec / abandonSpec (the spec-attempt lease facts)', () => {
  // Promote a demand to an item first, then drive the item's spec attempt.
  function promotedItem(): string {
    const d = raise()
    track.claimDemand(d, { handler: 'h' })
    return track.agreeDemand(d, { handler: 'h', items: [{ title: 'work' }] })[0]!
  }

  it('startSpec records a durable spec.started fact with itemId + handler', () => {
    const itemId = promotedItem()
    track.startSpec(itemId, { handler: 'h:spec' })
    const ev = store.readAll().find((e) => e.type === 'spec.started')!
    expect(ev.aggregate).toBe('item')
    expect(ev.aggregateId).toBe(itemId)
    expect(ev.payload).toMatchObject({ itemId, handler: 'h:spec' })
  })

  it('abandonSpec records a durable spec.abandoned fact (who/why)', () => {
    const itemId = promotedItem()
    track.startSpec(itemId, { handler: 'h:spec' })
    track.abandonSpec(itemId, { handler: 'h:spec', reason: 'ctx exhausted' })
    const ev = store.readAll().find((e) => e.type === 'spec.abandoned')!
    expect(ev.payload).toMatchObject({ itemId, handler: 'h:spec', reason: 'ctx exhausted' })
  })

  it('rejects startSpec / abandonSpec on an unknown item', () => {
    expect(() => track.startSpec('nope', { handler: 'h' })).toThrow(/unknown item/)
    expect(() => track.abandonSpec('nope', { handler: 'h', reason: 'r' })).toThrow(/unknown item/)
  })
})

describe('handler precedence (handler = ctx.handler ?? prov.principal ?? by)', () => {
  it('falls back to prov.principal when no explicit handler is given', () => {
    const t = freshTrack({ by: 'system', prov: { transport: 'mcp-stdio', proposed: true, auth: 'signed', principal: 'claude:track:xyz' } })
    const d = t.raiseDemand({ type: 'feature', raw, source }) // no handler in input
    const ev = store.readAll().find((e) => e.type === 'demand.raised')!
    expect((ev.payload as { handler: string }).handler).toBe('claude:track:xyz')
  })

  it('falls back to by when neither ctx.handler nor prov.principal is present', () => {
    const t = freshTrack({ by: 'cli-user' })
    const d = t.raiseDemand({ type: 'feature', raw, source })
    void d
    const ev = store.readAll().find((e) => e.type === 'demand.raised')!
    expect((ev.payload as { handler: string }).handler).toBe('cli-user')
  })

  it('an explicit handler wins over prov.principal and by', () => {
    const t = freshTrack({ by: 'cli-user', prov: { transport: 'mcp-stdio', proposed: true, auth: 'signed', principal: 'relayer' } })
    const d = t.raiseDemand({ type: 'feature', raw, source, handler: 'explicit:handler' })
    void d
    const ev = store.readAll().find((e) => e.type === 'demand.raised')!
    expect((ev.payload as { handler: string }).handler).toBe('explicit:handler')
  })
})

describe('additive-hash invariant (a pre-demand log folds + hashes byte-identical)', () => {
  it('a pre-demand item stream folds + re-replays byte-identically (demand additions are purely additive)', () => {
    // Build a stream of EXISTING (pre-demand) events twice and confirm seq/prevHash/contentHash are identical —
    // proving the new aggregate/event types/optional fields did not perturb the existing serialization.
    const replay = (s: EventStore): TrackEvent[] => {
      let n = 0
      const t = new Track(s, { by: 'tester', now: () => NOW, newId: () => `id-${String(++n).padStart(4, '0')}` })
      const item = t.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
      t.setSpec(item, 'specified')
      return s.readAll()
    }
    const a = new EventStore(join(dir, 's-a', '.track', 'events.jsonl'))
    const b = new EventStore(join(dir, 's-b', '.track', 'events.jsonl'))
    const ea = replay(a)
    const eb = replay(b)
    // none of the pre-demand events carry the new optional fields (demandId/handler) ⇒ canonicalize dropped them
    expect(ea.some((e) => 'demandId' in (e.payload as object))).toBe(false)
    expect(eb).toEqual(ea) // identical seq/prevHash/contentHash — purely additive
  })

  it('an item.created WITHOUT demandId hashes byte-identical to the frozen pre-demand core (no field leaked)', () => {
    const itemId = track.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    const created = store.readAll().find((e) => e.type === 'item.created' && e.aggregateId === itemId)!
    expect('demandId' in (created.payload as object)).toBe(false)
    // its contentHash equals computeHash over the stripped core (no demandId leaked into the bytes)
    expect(computeHash(stripFrame(created))).toBe(created.contentHash)
  })
})

describe('scoped under-lock semantic-race guard (F2)', () => {
  it('rejects a contradictory concurrent demand command folded from the same pre-lock state', () => {
    // Two commands both fold the SAME pre-lock state (demand in qualifying) and both try to settle it. The
    // first commits (agreed); the second — folded from the stale pre-lock view that still saw qualifying —
    // must be rejected UNDER THE LOCK by the demand-scoped recheck (re-fold + re-assert the transition).
    const path = join(dir, 'race', '.track', 'events.jsonl')
    const store2 = new EventStore(path)
    let n = 0
    const mk = () => new Track(store2, { by: 'tester', now: () => NOW, newId: () => `id-${String(++n).padStart(4, '0')}` })
    const t = mk()
    const d = t.raiseDemand({ type: 'feature', raw, source, handler: 'h' })
    t.claimDemand(d, { handler: 'h' })

    // A store whose FIRST readAll() (the facade's pre-lock fold) is STALE (demand still qualifying), but whose
    // UNDER-LOCK readAll() in appendCommand sees the CURRENT log (now agreed). This isolates exactly the
    // pre-lock-stale → under-lock-fresh race the scoped guard must catch.
    const staleSnapshot = store2.readAll()
    class StalePreLockStore extends EventStore {
      private served = false
      override readAll(): ReturnType<EventStore['readAll']> {
        if (!this.served) {
          this.served = true
          return staleSnapshot
        }
        return super.readAll()
      }
    }
    // First writer wins: agree the demand on the real store.
    t.agreeDemand(d, { handler: 'h', items: [{ title: 'won' }] })
    const after = store2.readAll().length

    // Second writer: its facade fold is the STALE qualifying snapshot, so the facade-level assert PASSES; the
    // under-lock recheck must re-fold the (now-agreed) log and REJECT the contradictory disposition.
    const racing = new StalePreLockStore(path)
    let m = 0
    const t2 = new Track(racing, { by: 'tester', now: () => NOW, newId: () => `id-${String(++m).padStart(4, '0')}` })
    expect(() => t2.disposeDemand(d, { outcome: 'rejected', handler: 'h2', reason: 'race' })).toThrow()
    // nothing extra appended — the contradictory command was rejected under the lock
    expect(store2.readAll().length).toBe(after)
    expect(store2.readAll().filter((e) => e.type === 'demand.disposition').length).toBe(0)
  })

  it('the guard does NOT block a legitimate (non-contradictory) demand command', () => {
    const d = raise()
    expect(() => track.claimDemand(d, { handler: 'h' })).not.toThrow()
    expect(track.state().demands.get(d)!.status).toBe('qualifying')
  })
})
