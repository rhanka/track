import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { contentHashOf } from './events/frame.js'
import { readHead } from './events/head.js'
import { EventStore } from './events/store.js'
import type { Provenance, TrackEvent, Ulid } from './events/types.js'
import { EVENT_TYPES } from './events/types.js'
import { validate } from './events/validate.js'
import { ingest, type IngestContext } from './ingest/ingest.js'
import { WORK_EVENT_KINDS } from './ingest/contract.js'
import type { WorkEvent } from './ingest/contract.js'
import { DomainError } from './model/item.js'
import { computeWpTree } from './report/rollup.js'
import { formatWpTree } from './report/format.js'
import { Track } from './track.js'
import { runCli } from './cli/index.js'

let dir: string
let eventsPath: string
let store: EventStore
let t: Track

const now = (): string => '2026-06-09T00:00:00.000Z'
const counter = (): (() => Ulid) => {
  let i = 0
  return () => `id-${String(++i).padStart(4, '0')}`
}
const PROV: Provenance = { transport: 'import', proposed: false, auth: 'local-user' }
const base = { baselineCommit: 'c1' as const }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-wp-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  store = new EventStore(eventsPath)
  t = new Track(store, { by: 'human:x', now })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const integral = (): boolean => validate(store.readAll(), readHead(eventsPath)).ok

// ---- 1. role marker (additive + queryable) ----------------------------------------------------

describe('WP foundation — role:"workpackage" marker (additive)', () => {
  it('persists role on item.created and folds it onto ItemState', () => {
    const id = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    const item = t.state().items.get(id)!
    expect(item.role).toBe('workpackage')
    const payload = store.readAll()[0]!.payload as Record<string, unknown>
    expect(payload['role']).toBe('workpackage')
    expect(integral()).toBe(true)
  })

  it('omits role when not supplied (hash-identical to a pre-WP event)', () => {
    t.createItem({ kind: 'chore', title: 'plain', workspace: 'ws' })
    const item = t.state().items.get(store.readAll()[0]!.aggregateId)!
    expect('role' in (store.readAll()[0]!.payload as Record<string, unknown>)).toBe(false)
    expect(item.role).toBeUndefined()
    expect(integral()).toBe(true)
  })

  it('is queryable via query({role})', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws', parentId: wp })
    const rows = t.query({ role: 'workpackage' }, base)
    expect(rows.map((r) => r.id)).toEqual([wp])
    expect(rows[0]!.role).toBe('workpackage')
  })
})

// ---- old-log hash stability -------------------------------------------------------------------

describe('WP foundation — pre-0.9 log hashes byte-identically with role/reparent absent', () => {
  it('a hand-written pre-WP item.created event still validates and re-hashes identically', () => {
    // A fixed pre-WP item.created core (no role, no reparent in the log). Its contentHash must be
    // exactly what the current code computes — proving the additive field changed nothing.
    const core = {
      id: 'id-0001',
      type: 'item.created' as const,
      aggregate: 'item' as const,
      aggregateId: 'agg-0001',
      at: '2026-01-01T00:00:00.000Z',
      by: 'human:x',
      payload: { kind: 'chore', title: 'pre-wp', workspace: 'ws' },
    }
    const contentHash = contentHashOf(core)
    const event: TrackEvent = { ...core, seq: 1, prevHash: null, contentHash }
    expect(validate([event]).ok).toBe(true)
    // recompute today — must match byte-for-byte (no new field crept into the hash domain)
    expect(contentHashOf(core)).toBe(contentHash)
  })
})

// ---- 2. item.reparent -------------------------------------------------------------------------

describe('WP foundation — item.reparent (additive event on the existing item aggregate)', () => {
  it('appends item.reparented as event type and pins the EVENT_TYPES/WORK_EVENT_KINDS names', () => {
    expect(EVENT_TYPES).toContain('item.reparented')
    expect([...WORK_EVENT_KINDS]).toContain('item.reparent')
  })

  it('sets parentId on the existing aggregate (no recreate, next seq)', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'c', workspace: 'ws' })
    t.reparentItem(child, wp)
    const item = t.state().items.get(child)!
    expect(item.parentId).toBe(wp)
    // same aggregate, next seq (created=1, reparented=2), identity preserved
    const evs = store.readAll().filter((e) => e.aggregateId === child)
    expect(evs.map((e) => [e.type, e.seq])).toEqual([
      ['item.created', 1],
      ['item.reparented', 2],
    ])
    expect(integral()).toBe(true)
  })

  it('clears parentId when called with no parent (detach to root)', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'c', workspace: 'ws', parentId: wp })
    t.reparentItem(child)
    expect(t.state().items.get(child)!.parentId).toBeUndefined()
    expect(integral()).toBe(true)
  })

  it('rejects an unknown item', () => {
    expect(() => t.reparentItem('NOPE')).toThrow(DomainError)
  })

  it('rejects an unknown parent', () => {
    const child = t.createItem({ kind: 'chore', title: 'c', workspace: 'ws' })
    expect(() => t.reparentItem(child, 'NOPE')).toThrow(DomainError)
  })

  it('rejects self-parenting', () => {
    const a = t.createItem({ kind: 'chore', title: 'a', workspace: 'ws' })
    expect(() => t.reparentItem(a, a)).toThrow(DomainError)
  })

  it('rejects a cycle (parent is a transitive descendant)', () => {
    const a = t.createItem({ kind: 'chore', title: 'a', workspace: 'ws', role: 'workpackage' })
    const b = t.createItem({ kind: 'chore', title: 'b', workspace: 'ws', role: 'workpackage', parentId: a })
    const c = t.createItem({ kind: 'chore', title: 'c', workspace: 'ws', parentId: b })
    // making a a child of c would close the loop a -> b -> c -> a
    expect(() => t.reparentItem(a, c)).toThrow(DomainError)
  })

  it('rejects cross-workspace reparenting', () => {
    const parent = t.createItem({ kind: 'chore', title: 'p', workspace: 'wsA', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'c', workspace: 'wsB' })
    expect(() => t.reparentItem(child, parent)).toThrow(DomainError)
  })
})

// ---- 2a. WP-under-WP invariant (deferred gap, DESIGN §2) ---------------------------------------

describe('WP foundation — a workpackage nests only under a workpackage (DESIGN §2)', () => {
  it('rejects a WP reparented under a NON-WP item', () => {
    const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws' })
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    expect(() => t.reparentItem(wp, leaf)).toThrow(DomainError)
    expect(() => t.reparentItem(wp, leaf)).toThrow(/workpackage may only nest under a workpackage/)
  })

  it('allows a WP reparented under another WP', () => {
    const parentWp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    const childWp = t.createItem({ kind: 'chore', title: 'WP1.1', workspace: 'ws', role: 'workpackage' })
    t.reparentItem(childWp, parentWp)
    expect(t.state().items.get(childWp)!.parentId).toBe(parentWp)
    expect(integral()).toBe(true)
  })

  it('allows a NON-WP leaf reparented under a WP (unchanged back-compat)', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws' })
    t.reparentItem(leaf, wp)
    expect(t.state().items.get(leaf)!.parentId).toBe(wp)
    expect(integral()).toBe(true)
  })

  it('allows a NON-WP leaf reparented under another leaf (unchanged — feature→chore)', () => {
    const feature = t.createItem({ kind: 'feature', title: 'f', workspace: 'ws' })
    const chore = t.createItem({ kind: 'chore', title: 'c', workspace: 'ws' })
    t.reparentItem(chore, feature)
    expect(t.state().items.get(chore)!.parentId).toBe(feature)
    expect(integral()).toBe(true)
  })

  it('allows a WP detached to root (parentId undefined)', () => {
    const parentWp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    const childWp = t.createItem({ kind: 'chore', title: 'WP1.1', workspace: 'ws', role: 'workpackage', parentId: parentWp })
    t.reparentItem(childWp)
    expect(t.state().items.get(childWp)!.parentId).toBeUndefined()
    expect(integral()).toBe(true)
  })

  it('rejects creating a WP with a NON-WP parent', () => {
    const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws' })
    expect(() => t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage', parentId: leaf })).toThrow(DomainError)
  })

  it('allows creating a WP with a WP parent', () => {
    const parentWp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    const childWp = t.createItem({ kind: 'chore', title: 'WP1.1', workspace: 'ws', role: 'workpackage', parentId: parentWp })
    expect(t.state().items.get(childWp)!.parentId).toBe(parentWp)
    expect(integral()).toBe(true)
  })
})

// ---- 2b. ingest binding gate for item.reparent ------------------------------------------------

describe('WP foundation — item.reparent via ingest (binding, parity-gated, contained)', () => {
  const ev = (kind: string, payload: Record<string, unknown>): WorkEvent =>
    ({ v: 1, kind, payload } as WorkEvent)
  const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({
    by: 'human:t',
    workspace: 'ws',
    prov: PROV,
    now,
    newId: counter(),
    ...over,
  })

  it('an authenticated channel may reparent', () => {
    const s = new EventStore(join(dir, 'auth', '.track', 'events.jsonl'))
    const ids = ingest(
      [
        ev('item.create', { kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' }),
        ev('item.create', { kind: 'chore', title: 'c', workspace: 'ws' }),
      ],
      ctx(),
      s,
    ).ids
    const [wp, child] = ids as string[]
    ingest([ev('item.reparent', { itemId: child, parentId: wp })], ctx(), s)
    expect(new Track(s).state().items.get(child!)!.parentId).toBe(wp)
  })

  it('an UNAUTHENTICATED channel is rejected (binding gate)', () => {
    const s = new EventStore(join(dir, 'unauth', '.track', 'events.jsonl'))
    const wp = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })], ctx(), s).ids[0] as string
    const child = ingest([ev('item.create', { kind: 'chore', title: 'c', workspace: 'ws' })], ctx(), s).ids[0] as string
    expect(() =>
      ingest(
        [ev('item.reparent', { itemId: child, parentId: wp })],
        ctx({ prov: { transport: 'http', proposed: true, auth: 'unauthenticated' } }),
        s,
      ),
    ).toThrow()
  })

  it('a foreign-workspace target is rejected (containment from folded state)', () => {
    const s = new EventStore(join(dir, 'foreign', '.track', 'events.jsonl'))
    // child created in wsA via a wsA-pinned channel; a wsB channel must not reparent it.
    const wpA = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'wsA', role: 'workpackage' })], ctx({ workspace: 'wsA' }), s).ids[0] as string
    const childA = ingest([ev('item.create', { kind: 'chore', title: 'c', workspace: 'wsA' })], ctx({ workspace: 'wsA' }), s).ids[0] as string
    expect(() =>
      ingest([ev('item.reparent', { itemId: childA, parentId: wpA })], ctx({ workspace: 'wsB' }), s),
    ).toThrow()
  })

  it('rejects a WP reparented under a NON-WP item (WP-under-WP guard funnels through reparentItem)', () => {
    const s = new EventStore(join(dir, 'wp-under-nonwp', '.track', 'events.jsonl'))
    const c = ctx({ newId: counter() }) // ONE shared id generator so leaf/wp get distinct ids
    const leaf = ingest([ev('item.create', { kind: 'chore', title: 'leaf', workspace: 'ws' })], c, s).ids[0] as string
    const wp = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })], c, s).ids[0] as string
    expect(() => ingest([ev('item.reparent', { itemId: wp, parentId: leaf })], c, s)).toThrow(
      /workpackage may only nest under a workpackage/,
    )
  })
})

// ---- 3. %-rollup report -----------------------------------------------------------------------

describe('WP foundation — WP excluded from flat buckets + leaf %', () => {
  it('a role:"workpackage" item is absent from the flat buckets', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws', parentId: wp })
    const report = t.report(base)
    const everyId = Object.values(report.buckets).flat().map((r) => r.id)
    expect(everyId).not.toContain(wp)
    expect(everyId).toContain(leaf)
  })
})

describe('WP foundation — computeWpTree rollup', () => {
  const cfg = { baselineCommit: 'c1', requireAccepted: false }
  const done = (id: string): void => {
    t.setRealization(id, 'in-progress')
    t.setRealization(id, 'done')
  }

  it('rolls done/active up from non-WP leaf descendants, with dotted labels', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    const a = t.createItem({ kind: 'chore', title: 'a', workspace: 'ws', parentId: wp })
    const b = t.createItem({ kind: 'chore', title: 'b', workspace: 'ws', parentId: wp })
    done(a)
    const tree = computeWpTree(t.state(), cfg)
    expect(tree).toHaveLength(1)
    expect(tree[0]!.label).toBe('WP1')
    expect(tree[0]!.done).toBe(1)
    expect(tree[0]!.active).toBe(2)
    expect(tree[0]!.pct).toBe(50)
    expect(tree[0]!.id).toBe(wp)
    void [a, b] // a is done, b is to-do — both counted as active leaves
  })

  it('parent counts are the SUM of descendant leaves, never the mean of child percentages (Simpson)', () => {
    // WP1 has two sub-WPs: a 1-leaf one (1 done ⇒ 100%) and a 4-leaf one (2 done ⇒ 50%).
    // mean-of-pcts = (100 + 50)/2 = 75% (WRONG). sum-of-leaves = 3/5 = 60% (CORRECT).
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    const small = t.createItem({ kind: 'chore', title: 'small', workspace: 'ws', role: 'workpackage', parentId: wp })
    const big = t.createItem({ kind: 'chore', title: 'big', workspace: 'ws', role: 'workpackage', parentId: wp })
    const s1 = t.createItem({ kind: 'chore', title: 's1', workspace: 'ws', parentId: small })
    done(s1)
    for (let i = 0; i < 4; i++) {
      const leaf = t.createItem({ kind: 'chore', title: `big-${i}`, workspace: 'ws', parentId: big })
      if (i < 2) done(leaf)
    }
    const tree = computeWpTree(t.state(), cfg)
    const root = tree.find((n) => n.id === wp)!
    expect(root.done).toBe(3)
    expect(root.active).toBe(5)
    expect(root.pct).toBe(60) // NOT 75 (the mean-of-pcts trap)
    // each sub-WP rolls up its own leaves
    const smallNode = root.children.find((c) => c.id === small)!
    const bigNode = root.children.find((c) => c.id === big)!
    expect([smallNode.done, smallNode.active, smallNode.pct]).toEqual([1, 1, 100])
    expect([bigNode.done, bigNode.active, bigNode.pct]).toEqual([2, 4, 50])
    // sub-WP labels are dotted from tree position
    const labels = root.children.map((c) => c.label).sort()
    expect(labels).toEqual(['WP1.1', 'WP1.2'])
  })

  it('renders Markdown in the agent-stats shape (WP-N (done/total, pct%) → Lot N.M → [x]/[ ])', () => {
    const wp = t.createItem({ kind: 'chore', title: 'Record Integrity', workspace: 'ws', role: 'workpackage' })
    const lot = t.createItem({ kind: 'chore', title: 'Frozen chain', workspace: 'ws', role: 'workpackage', parentId: wp })
    const a = t.createItem({ kind: 'chore', title: 'task A', workspace: 'ws', parentId: lot })
    t.createItem({ kind: 'chore', title: 'task B', workspace: 'ws', parentId: lot })
    done(a)
    const md = formatWpTree(computeWpTree(t.state(), cfg))
    // dotted labels, done/total + pct, and checkbox leaves
    expect(md).toContain('WP1')
    expect(md).toContain('Record Integrity')
    expect(md).toContain('(1/2, 50%)')
    expect(md).toContain('WP1.1')
    expect(md).toContain('[x] task A')
    expect(md).toContain('[ ] task B')
  })

  it('0/0 (no active leaves) is n/a, never 100%', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP-empty', workspace: 'ws', role: 'workpackage' })
    const dropped = t.createItem({ kind: 'chore', title: 'd', workspace: 'ws', parentId: wp })
    t.setRealization(dropped, 'cancelled') // DROPPED — shown but excluded from %
    const tree = computeWpTree(t.state(), cfg)
    const node = tree.find((n) => n.id === wp)!
    expect(node.active).toBe(0)
    expect(node.done).toBe(0)
    expect(node.dropped).toBe(1)
    expect(node.pct).toBe('n/a')
  })
})

// ---- CLI ≡ ingest parity for the new kind -----------------------------------------------------

describe('WP foundation — CLI ≡ ingest parity (item reparent / item new --role)', () => {
  const cli = (...argv: string[]): { code: number; out: string; err: string } => {
    const out: string[] = []
    const err: string[] = []
    const io = { cwd: dir, out: (s: string) => out.push(s), err: (s: string) => err.push(s) }
    // sync commands only here → runCli returns a plain number (the async `focus` path is not exercised)
    return { code: runCli(argv, io) as number, out: out.join(''), err: err.join('') }
  }

  it('item new --role workpackage marks the item; item reparent moves it', () => {
    cli('init')
    const wp = cli('item', 'new', '--kind', 'chore', '--title', 'WP', '--workspace', 'ws', '--role', 'workpackage').out.trim()
    const child = cli('item', 'new', '--kind', 'chore', '--title', 'c', '--workspace', 'ws').out.trim()
    const r = cli('item', 'reparent', child, '--parent', wp)
    expect(r.code).toBe(0)
    const reader = new EventStore(join(dir, '.track', 'events.jsonl'))
    const state = new Track(reader).state()
    expect(state.items.get(wp)!.role).toBe('workpackage')
    expect(state.items.get(child)!.parentId).toBe(wp)
  })

  it('report --wp renders the rollup and keeps the WP out of the flat buckets', () => {
    cli('init')
    const wp = cli('item', 'new', '--kind', 'chore', '--title', 'WP1', '--workspace', 'ws', '--role', 'workpackage').out.trim()
    cli('item', 'new', '--kind', 'chore', '--title', 'leaf', '--workspace', 'ws', '--parent', wp)
    const r = cli('report', '--wp', '--format', 'md', '--commit', 'c1')
    expect(r.code).toBe(0)
    expect(r.out).toContain('WP1') // the rollup section
    // the WP container itself is not listed as a TO-DO leaf row
    expect(r.out).not.toMatch(/- \*\*WP1\*\* — to-do/)
  })
})
