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
import { LeaseStore, leasesPathFor } from './lease/store.js'
import { Track } from './track.js'

let dir: string
let store: EventStore
let track: Track

const NOW = '2026-06-21T10:00:00.000Z'

function freshTrack(over: { by?: string; prov?: Provenance; leases?: LeaseStore; now?: string } = {}): Track {
  let n = 0
  return new Track(store, {
    by: over.by ?? 'tester',
    now: () => over.now ?? NOW,
    newId: () => `id-${String(++n).padStart(4, '0')}`,
    ...(over.prov !== undefined ? { prov: over.prov } : {}),
    ...(over.leases !== undefined ? { leases: over.leases } : {}),
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
  return track.raiseDemand({ type: 'feature', workspace: 'ws', raw, source, handler: 'h:raiser', ...over } as Parameters<Track['raiseDemand']>[0])
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
    expect(() => track.raiseDemand({ type: 'epic' as never, workspace: 'ws', raw, source, handler: 'h' })).toThrow()
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
    const d = t.raiseDemand({ type: 'feature', workspace: 'ws', raw, source }) // no handler in input
    const ev = store.readAll().find((e) => e.type === 'demand.raised')!
    expect((ev.payload as { handler: string }).handler).toBe('claude:track:xyz')
  })

  it('falls back to by when neither ctx.handler nor prov.principal is present', () => {
    const t = freshTrack({ by: 'cli-user' })
    const d = t.raiseDemand({ type: 'feature', workspace: 'ws', raw, source })
    void d
    const ev = store.readAll().find((e) => e.type === 'demand.raised')!
    expect((ev.payload as { handler: string }).handler).toBe('cli-user')
  })

  it('an explicit handler wins over prov.principal and by', () => {
    const t = freshTrack({ by: 'cli-user', prov: { transport: 'mcp-stdio', proposed: true, auth: 'signed', principal: 'relayer' } })
    const d = t.raiseDemand({ type: 'feature', workspace: 'ws', raw, source, handler: 'explicit:handler' })
    void d
    const ev = store.readAll().find((e) => e.type === 'demand.raised')!
    expect((ev.payload as { handler: string }).handler).toBe('explicit:handler')
  })
})

describe('Build 2 — the LIVE lease holder defaults the handler (top of the precedence)', () => {
  const leasesAt = (when: string): LeaseStore =>
    new LeaseStore(leasesPathFor(join(dir, '.track', 'events.jsonl')), { now: () => when, newId: () => `tok-${when}` })

  function leases(when = NOW): LeaseStore {
    return leasesAt(when)
  }

  it('a live lease on the demand defaults the transition handler to the lease HOLDER', () => {
    const raiseT = freshTrack({ by: 'cli-user' })
    const d = raiseT.raiseDemand({ type: 'feature', workspace: 'ws', raw, source, handler: 'h:raiser' })
    const lease = leases()
    lease.acquire({ workspace: 'ws', subject: { kind: 'demand', id: d }, phase: 'qualifying', holder: 'h:leaseholder' })
    // claim with NO explicit handler ⇒ the lease holder wins over `by` (cli-user) and any principal.
    const t = freshTrack({ by: 'cli-user', leases: lease })
    t.claimDemand(d)
    const ev = store.readAll().find((e) => e.type === 'demand.qualifying-started')!
    expect((ev.payload as { handler: string }).handler).toBe('h:leaseholder')
  })

  it('an ABANDONED lease does NOT default the handler (falls back to by)', () => {
    const raiseT = freshTrack({ by: 'cli-user' })
    const d = raiseT.raiseDemand({ type: 'feature', workspace: 'ws', raw, source, handler: 'h:raiser' })
    // acquire at NOW with a tiny ttl; resolve at a much later now ⇒ the lease is abandoned ⇒ no default.
    leasesAt(NOW).acquire({
      workspace: 'ws',
      subject: { kind: 'demand', id: d },
      phase: 'qualifying',
      holder: 'h:dead',
      ttlMs: 1_000,
    })
    const later = new Date(Date.parse(NOW) + 10_000).toISOString()
    const t = freshTrack({ by: 'cli-user', leases: leasesAt(later), now: later })
    t.claimDemand(d)
    const ev = store.readAll().find((e) => e.type === 'demand.qualifying-started')!
    expect((ev.payload as { handler: string }).handler).toBe('cli-user') // NOT h:dead
  })

  it('an explicit handler STILL wins over a live lease holder (explicit handover override)', () => {
    const raiseT = freshTrack({ by: 'cli-user' })
    const d = raiseT.raiseDemand({ type: 'feature', workspace: 'ws', raw, source, handler: 'h:raiser' })
    const lease = leases()
    lease.acquire({ workspace: 'ws', subject: { kind: 'demand', id: d }, phase: 'qualifying', holder: 'h:leaseholder' })
    const t = freshTrack({ by: 'cli-user', leases: lease })
    t.claimDemand(d, { handler: 'h:explicit' })
    const ev = store.readAll().find((e) => e.type === 'demand.qualifying-started')!
    expect((ev.payload as { handler: string }).handler).toBe('h:explicit')
  })

  it('a live spec lease on an ITEM defaults the spec.started handler', () => {
    const t0 = freshTrack({ by: 'cli-user' })
    const item = t0.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
    const lease = leases()
    lease.acquire({ workspace: 'ws', subject: { kind: 'item', id: item }, phase: 'specifying', holder: 'h:specwriter' })
    const t = freshTrack({ by: 'cli-user', leases: lease })
    t.startSpec(item, {})
    const ev = store.readAll().find((e) => e.type === 'spec.started')!
    expect((ev.payload as { handler: string }).handler).toBe('h:specwriter')
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
    // FROZEN GOLDEN — pin the exact bytes against a LITERAL hash (computed once from the current canonical
    // form, with the deterministic clock/newId of `freshTrack`). Self-consistency (above) only proves the
    // hash matches its OWN canonical bytes; this catches a regression that *changes* pre-demand hashing
    // (e.g. a new field leaking into the canonical core, or a canonicalizer change) — both events would still
    // be self-consistent yet would no longer equal this frozen baseline. If this fails, the additive invariant
    // (old logs replay byte-identical) is BROKEN — do not re-pin without understanding why the bytes moved.
    expect(created.contentHash).toBe('sha256:50f39131933adaf5f0bb8e2e9f006882bdc5df882ec331a043c022cfd38e5837')
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
    const d = t.raiseDemand({ type: 'feature', workspace: 'ws', raw, source, handler: 'h' })
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

  it('rejects a mutual-duplicate race so a survivor always remains (A↔B, no data loss)', () => {
    // Data-loss bug: two actors race `dispose A duplicateOf B` and `dispose B duplicateOf A` from the SAME
    // pre-lock state where both are qualifying. If both committed, BOTH demands would be terminal `duplicate`
    // pointing at each other with NO survivor (real work lost). The under-lock recheck must catch the second
    // writer: its target (A) is now terminal-`duplicate` (a non-survivor) ⇒ REJECT, leaving B as the survivor.
    const path = join(dir, 'dup-race', '.track', 'events.jsonl')
    const store2 = new EventStore(path)
    let n = 0
    const mk = () => new Track(store2, { by: 'tester', now: () => NOW, newId: () => `id-${String(++n).padStart(4, '0')}` })
    const t = mk()
    const a = t.raiseDemand({ type: 'feature', workspace: 'ws', raw, source, handler: 'h' })
    const b = t.raiseDemand({ type: 'feature', workspace: 'ws', raw, source, handler: 'h' })
    t.claimDemand(a, { handler: 'h' })
    t.claimDemand(b, { handler: 'h' })

    // Both actors folded THIS pre-lock state (A and B both qualifying — each a valid survivor for the other).
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

    // Actor 1 wins: A → duplicate(B) commits on the real store (B is qualifying ⇒ a valid survivor).
    t.disposeDemand(a, { outcome: 'duplicate', handler: 'h1', reason: 'dup', duplicateOf: { kind: 'demand', id: b } })
    const after = store2.readAll().length

    // Actor 2: its facade fold is the STALE snapshot (A still qualifying ⇒ a "valid" survivor), so the facade
    // assert PASSES; the under-lock recheck must re-fold the (now A=duplicate) log and REJECT — A is a
    // non-survivor, so disposing B→duplicate(A) would leave NO survivor.
    const racing = new StalePreLockStore(path)
    let m = 0
    const t2 = new Track(racing, { by: 'tester', now: () => NOW, newId: () => `id-${String(++m).padStart(4, '0')}` })
    expect(() =>
      t2.disposeDemand(b, { outcome: 'duplicate', handler: 'h2', reason: 'dup', duplicateOf: { kind: 'demand', id: a } }),
    ).toThrow(/survivor/i)

    // Nothing extra appended; exactly ONE survivor remains: A is duplicate, B is still qualifying (the survivor).
    expect(store2.readAll().length).toBe(after)
    expect(t.state().demands.get(a)!.status).toBe('duplicate')
    expect(t.state().demands.get(b)!.status).toBe('qualifying')
  })

  it('rejects (at the facade) a duplicate whose survivor demand is itself terminal duplicate/rejected', () => {
    // Even without a race, a `duplicateOf` target whose own status is a non-survivor (terminal duplicate or
    // rejected) must be rejected at the facade — pointing at a non-survivor loses the demand with no real heir.
    const survivor = raise()
    const deadDup = raise()
    const deadRej = raise()
    track.claimDemand(survivor, { handler: 'h' })
    track.claimDemand(deadDup, { handler: 'h' })
    track.disposeDemand(deadDup, { outcome: 'duplicate', handler: 'h', reason: 'dup', duplicateOf: { kind: 'demand', id: survivor } })
    track.claimDemand(deadRej, { handler: 'h' })
    track.disposeDemand(deadRej, { outcome: 'rejected', handler: 'h', reason: 'no' })

    const d = raise()
    track.claimDemand(d, { handler: 'h' })
    expect(() =>
      track.disposeDemand(d, { outcome: 'duplicate', handler: 'h', reason: 'x', duplicateOf: { kind: 'demand', id: deadDup } }),
    ).toThrow(/survivor/i)
    expect(() =>
      track.disposeDemand(d, { outcome: 'duplicate', handler: 'h', reason: 'x', duplicateOf: { kind: 'demand', id: deadRej } }),
    ).toThrow(/survivor/i)
    // a still-qualifying survivor is accepted
    expect(() =>
      track.disposeDemand(d, { outcome: 'duplicate', handler: 'h', reason: 'x', duplicateOf: { kind: 'demand', id: survivor } }),
    ).not.toThrow()
  })
})
