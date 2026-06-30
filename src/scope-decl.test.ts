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
import { ITEM_ROLES, WORK_EVENT_KINDS } from './ingest/contract.js'
import type { WorkEvent } from './ingest/contract.js'
import { DomainError } from './model/item.js'
import type { ScopeDecl } from './model/item.js'
import { computeWpTree } from './report/rollup.js'
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
  dir = mkdtempSync(join(tmpdir(), 'track-scope-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  store = new EventStore(eventsPath)
  t = new Track(store, { by: 'human:x', now })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const integral = (): boolean => validate(store.readAll(), readHead(eventsPath)).ok

// ---- 1. role:'spec-phase' (additive, folds + queryable) ----------------------------------------

describe('scope LOT(a) — role:"spec-phase" marker', () => {
  it('persists role:"spec-phase" on item.created and folds it onto ItemState', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const phase = t.createItem({ kind: 'chore', title: 'Phase A', workspace: 'ws', role: 'spec-phase', parentId: wp })
    const item = t.state().items.get(phase)!
    expect(item.role).toBe('spec-phase')
    const payload = store.readAll().find((e) => e.aggregateId === phase)!.payload as Record<string, unknown>
    expect(payload['role']).toBe('spec-phase')
    expect(integral()).toBe(true)
  })

  it('is queryable via query({role:"spec-phase"})', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const phase = t.createItem({ kind: 'chore', title: 'Phase', workspace: 'ws', role: 'spec-phase', parentId: wp })
    const rows = t.query({ role: 'spec-phase' }, base)
    expect(rows.map((r) => r.id)).toEqual([phase])
    expect(rows[0]!.role).toBe('spec-phase')
  })

  it('ITEM_ROLES enum exposes workpackage, spec-phase, and stream (A2 container)', () => {
    expect([...ITEM_ROLES]).toEqual(['workpackage', 'spec-phase', 'stream'])
  })
})

// ---- 2. nesting invariant --------------------------------------------------------------------

describe('scope LOT(a) — spec-phase nesting invariant', () => {
  it('allows a spec-phase under a workpackage', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const phase = t.createItem({ kind: 'chore', title: 'P', workspace: 'ws', role: 'spec-phase', parentId: wp })
    expect(t.state().items.get(phase)!.parentId).toBe(wp)
    expect(integral()).toBe(true)
  })

  it('allows a spec-phase under another spec-phase', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const p1 = t.createItem({ kind: 'chore', title: 'P1', workspace: 'ws', role: 'spec-phase', parentId: wp })
    const p2 = t.createItem({ kind: 'chore', title: 'P2', workspace: 'ws', role: 'spec-phase', parentId: p1 })
    expect(t.state().items.get(p2)!.parentId).toBe(p1)
    expect(integral()).toBe(true)
  })

  it('REJECTS a workpackage created under a spec-phase', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const phase = t.createItem({ kind: 'chore', title: 'P', workspace: 'ws', role: 'spec-phase', parentId: wp })
    expect(() =>
      t.createItem({ kind: 'chore', title: 'WP2', workspace: 'ws', role: 'workpackage', parentId: phase }),
    ).toThrow(DomainError)
  })

  it('REJECTS a workpackage reparented under a spec-phase', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const phase = t.createItem({ kind: 'chore', title: 'P', workspace: 'ws', role: 'spec-phase', parentId: wp })
    const wp2 = t.createItem({ kind: 'chore', title: 'WP2', workspace: 'ws', role: 'workpackage' })
    expect(() => t.reparentItem(wp2, phase)).toThrow(/workpackage may only nest under a workpackage/)
  })

  it('REJECTS a spec-phase created under a non-role leaf', () => {
    const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws' })
    expect(() =>
      t.createItem({ kind: 'chore', title: 'P', workspace: 'ws', role: 'spec-phase', parentId: leaf }),
    ).toThrow(/spec-phase may only nest under a workpackage or spec-phase/)
  })

  it('REJECTS a spec-phase reparented under a non-role leaf', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const phase = t.createItem({ kind: 'chore', title: 'P', workspace: 'ws', role: 'spec-phase', parentId: wp })
    const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws' })
    expect(() => t.reparentItem(phase, leaf)).toThrow(/spec-phase may only nest under a workpackage or spec-phase/)
  })

  it('allows a spec-phase detached to root (parentId undefined)', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const phase = t.createItem({ kind: 'chore', title: 'P', workspace: 'ws', role: 'spec-phase', parentId: wp })
    t.reparentItem(phase)
    expect(t.state().items.get(phase)!.parentId).toBeUndefined()
    expect(integral()).toBe(true)
  })

  it('allows a non-role leaf under a spec-phase', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const phase = t.createItem({ kind: 'chore', title: 'P', workspace: 'ws', role: 'spec-phase', parentId: wp })
    const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws', parentId: phase })
    expect(t.state().items.get(leaf)!.parentId).toBe(phase)
    expect(integral()).toBe(true)
  })
})

// ---- 3. rollup treats spec-phase as a container, not a leaf ------------------------------------

describe('scope LOT(a) — rollup excludes spec-phase from leaf counts', () => {
  const cfg = { baselineCommit: 'c1', requireAccepted: false }
  const done = (id: string): void => {
    t.setRealization(id, 'in-progress')
    t.setRealization(id, 'done')
  }

  it('descends through a spec-phase; it is not itself a leaf', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    const phase = t.createItem({ kind: 'chore', title: 'Phase', workspace: 'ws', role: 'spec-phase', parentId: wp })
    const a = t.createItem({ kind: 'chore', title: 'a', workspace: 'ws', parentId: phase })
    const b = t.createItem({ kind: 'chore', title: 'b', workspace: 'ws', parentId: phase })
    done(a)
    const tree = computeWpTree(t.state(), cfg)
    const root = tree.find((n) => n.id === wp)!
    // the two leaves under the phase roll up to the WP; the phase itself is NOT counted as a leaf
    expect(root.done).toBe(1)
    expect(root.active).toBe(2)
    expect(root.pct).toBe(50)
    void b
  })

  it('a spec-phase is absent from the flat buckets (container, not a leaf)', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    const phase = t.createItem({ kind: 'chore', title: 'Phase', workspace: 'ws', role: 'spec-phase', parentId: wp })
    const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws', parentId: phase })
    const report = t.report(base)
    const everyId = Object.values(report.buckets).flat().map((r) => r.id)
    expect(everyId).not.toContain(wp)
    expect(everyId).not.toContain(phase)
    expect(everyId).toContain(leaf)
  })
})

// ---- 4. scope.declare ------------------------------------------------------------------------

describe('scope LOT(a) — scope.declare sets item.scope', () => {
  const SCOPE: ScopeDecl = { allowed: ['src/a/**'], forbidden: ['src/b/**'] }

  it('appends scope.declared on the existing WP aggregate (next seq) and folds item.scope', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    t.declareScope(wp, SCOPE)
    expect(t.state().items.get(wp)!.scope).toEqual(SCOPE)
    const evs = store.readAll().filter((e) => e.aggregateId === wp)
    expect(evs.map((e) => [e.type, e.seq])).toEqual([
      ['item.created', 1],
      ['scope.declared', 2],
    ])
    expect(integral()).toBe(true)
  })

  it('sets scope on a spec-phase', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const phase = t.createItem({ kind: 'chore', title: 'P', workspace: 'ws', role: 'spec-phase', parentId: wp })
    t.declareScope(phase, { allowed: ['src/p/**'] })
    expect(t.state().items.get(phase)!.scope).toEqual({ allowed: ['src/p/**'] })
    expect(integral()).toBe(true)
  })

  it('REPLACES a prior scope declaration (latest wins)', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    t.declareScope(wp, { allowed: ['src/a/**'] })
    t.declareScope(wp, { allowed: ['src/b/**'], forbidden: ['src/c/**'] })
    expect(t.state().items.get(wp)!.scope).toEqual({ allowed: ['src/b/**'], forbidden: ['src/c/**'] })
  })

  it('REJECTS scope.declare on a non-role leaf item', () => {
    const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws' })
    expect(() => t.declareScope(leaf, SCOPE)).toThrow(DomainError)
  })

  it('REJECTS scope.declare on an unknown item', () => {
    expect(() => t.declareScope('NOPE', SCOPE)).toThrow(DomainError)
  })

  it('pins the event-type + work-event-kind names', () => {
    expect(EVENT_TYPES).toContain('scope.declared')
    expect([...WORK_EVENT_KINDS]).toContain('scope.declare')
  })
})

// ---- 5. scope.declare via ingest (binding, contained, role+workspace guard) --------------------

describe('scope LOT(a) — scope.declare via ingest', () => {
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

  it('an authenticated channel declares scope on a WP', () => {
    const s = new EventStore(join(dir, 'auth', '.track', 'events.jsonl'))
    const c = ctx()
    const wp = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })], c, s).ids[0] as string
    ingest([ev('scope.declare', { itemId: wp, scope: { allowed: ['src/**'] } })], c, s)
    expect(new Track(s).state().items.get(wp)!.scope).toEqual({ allowed: ['src/**'] })
  })

  it('an UNAUTHENTICATED channel is rejected (binding gate)', () => {
    const s = new EventStore(join(dir, 'unauth', '.track', 'events.jsonl'))
    const wp = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })], ctx(), s).ids[0] as string
    expect(() =>
      ingest(
        [ev('scope.declare', { itemId: wp, scope: { allowed: ['src/**'] } })],
        ctx({ prov: { transport: 'http', proposed: true, auth: 'unauthenticated' } }),
        s,
      ),
    ).toThrow()
  })

  it('a foreign-workspace target is rejected (containment)', () => {
    const s = new EventStore(join(dir, 'foreign', '.track', 'events.jsonl'))
    const wpA = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'wsA', role: 'workpackage' })], ctx({ workspace: 'wsA' }), s).ids[0] as string
    expect(() =>
      ingest([ev('scope.declare', { itemId: wpA, scope: { allowed: ['src/**'] } })], ctx({ workspace: 'wsB' }), s),
    ).toThrow()
  })
})

// ---- 6. additive hash-stability --------------------------------------------------------------

describe('scope LOT(a) — additive hash stability', () => {
  it('a pre-scope item.created event re-hashes identically (role/scope absent)', () => {
    const core = {
      id: 'id-0001',
      type: 'item.created' as const,
      aggregate: 'item' as const,
      aggregateId: 'agg-0001',
      at: '2026-01-01T00:00:00.000Z',
      by: 'human:x',
      payload: { kind: 'chore', title: 'pre-scope', workspace: 'ws' },
    }
    const contentHash = contentHashOf(core)
    const event: TrackEvent = { ...core, seq: 1, prevHash: null, contentHash }
    expect(validate([event]).ok).toBe(true)
    expect(contentHashOf(core)).toBe(contentHash)
  })

  it('omits scope/role on a plain item.created (hash-identical to pre-scope)', () => {
    t.createItem({ kind: 'chore', title: 'plain', workspace: 'ws' })
    const payload = store.readAll()[0]!.payload as Record<string, unknown>
    expect('role' in payload).toBe(false)
    expect('scope' in payload).toBe(false)
    expect(integral()).toBe(true)
  })
})

// ---- 7. CLI parity ---------------------------------------------------------------------------

describe('scope LOT(a) — CLI item new --role spec-phase / item scope-declare', () => {
  const cli = (...argv: string[]): { code: number; out: string; err: string } => {
    const out: string[] = []
    const err: string[] = []
    const io = { cwd: dir, out: (s: string) => out.push(s), err: (s: string) => err.push(s) }
    // sync commands only here → runCli returns a plain number (the async `focus` path is not exercised)
    return { code: runCli(argv, io) as number, out: out.join(''), err: err.join('') }
  }

  it('item new --role spec-phase marks the item; item scope-declare sets scope', () => {
    cli('init')
    const wp = cli('item', 'new', '--kind', 'chore', '--title', 'WP', '--workspace', 'ws', '--role', 'workpackage').out.trim()
    const phase = cli('item', 'new', '--kind', 'chore', '--title', 'P', '--workspace', 'ws', '--role', 'spec-phase', '--parent', wp).out.trim()
    const r = cli('item', 'scope-declare', phase, '--allowed', 'src/a/**,src/b/**', '--forbidden', 'src/c/**')
    expect(r.code).toBe(0)
    const state = new Track(new EventStore(join(dir, '.track', 'events.jsonl'))).state()
    expect(state.items.get(phase)!.role).toBe('spec-phase')
    expect(state.items.get(phase)!.scope).toEqual({ allowed: ['src/a/**', 'src/b/**'], forbidden: ['src/c/**'] })
  })
})
