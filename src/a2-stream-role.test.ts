// A2 — role:'stream' (DESIGN wp-codes-and-stream-role §A2). The MOST INVASIVE sub-lot of Lot A: a third
// container category `stream` (an EPIC above the workpackage) that is a CONTAINER (never a leaf) but is
// NOT numbered `WP<n>` — it takes its own derived `S<n>` sequence (or its A1 code, verbatim, when present).
// Covers: the additive ITEM_ROLES enum, the `item.role-changed` event + `setRole` facade (bounded
// container↔container, with whole-neighborhood nesting re-validation), the assertRoleNesting stream clause,
// the S<n>/WP<n> numbering partition, and the GATE — WITHOUT a stream or a role-change, BYTE-IDENTICAL.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readHead } from './events/head.js'
import { EventStore } from './events/store.js'
import type { Provenance, Ulid } from './events/types.js'
import { EVENT_TYPES } from './events/types.js'
import { validate } from './events/validate.js'
import { ingest, type IngestContext } from './ingest/ingest.js'
import { INGEST_CONTRACT_VERSION, ITEM_ROLES, WORK_EVENT_KINDS } from './ingest/contract.js'
import type { WorkEvent, WorkEventKind } from './ingest/contract.js'
import { mapWorkEvent } from './ingest/map.js'
import { assertRoleNesting, DomainError, isRoleContainer } from './model/item.js'
import { computeWpTree, wpRootId } from './report/rollup.js'
import { statusByLevel } from './report/status-by-level.js'
import { READ_CONTRACT_VERSION } from './read/contract.js'
import { scopeValidate } from './read/scope-validate.js'
import { Track } from './track.js'

let dir: string
let eventsPath: string
let store: EventStore
let t: Track

const now = (): string => '2026-06-29T00:00:00.000Z'
const counter = (): (() => Ulid) => {
  let i = 0
  return () => `id-${String(++i).padStart(4, '0')}`
}
const PROV: Provenance = { transport: 'import', proposed: false, auth: 'local-user' }
const cfg = { baselineCommit: 'c1', requireAccepted: false }
const base = { baselineCommit: 'c1' as const }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-a2-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  store = new EventStore(eventsPath)
  // Injected counter ids ⇒ deterministic ULID order (roots sort by id) for the numbering tests.
  t = new Track(store, { by: 'human:x', now, newId: counter() })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const integral = (): boolean => validate(store.readAll(), readHead(eventsPath)).ok
const wp = (title: string, parentId?: Ulid): Ulid =>
  t.createItem({ kind: 'chore', title, workspace: 'ws', role: 'workpackage', ...(parentId !== undefined ? { parentId } : {}) })
const stream = (title: string, parentId?: Ulid): Ulid =>
  t.createItem({ kind: 'chore', title, workspace: 'ws', role: 'stream', ...(parentId !== undefined ? { parentId } : {}) })
const phase = (title: string, parentId: Ulid): Ulid =>
  t.createItem({ kind: 'chore', title, workspace: 'ws', role: 'spec-phase', parentId })
const leaf = (title: string, parentId?: Ulid): Ulid =>
  t.createItem({ kind: 'chore', title, workspace: 'ws', ...(parentId !== undefined ? { parentId } : {}) })
const done = (id: Ulid): void => {
  t.setRealization(id, 'in-progress')
  t.setRealization(id, 'done')
}
const tree = () => computeWpTree(t.state(), cfg)
const labelOf = (id: Ulid): string | undefined => tree().find((n) => n.id === id)?.label

// ---- 1. contract pins --------------------------------------------------------------------------

describe('A2 — contract pins', () => {
  it('ITEM_ROLES exposes the third container category stream', () => {
    expect([...ITEM_ROLES]).toEqual(['workpackage', 'spec-phase', 'stream'])
  })
  it('pins the new event-type + work-event-kind + the INGEST/READ minor bumps', () => {
    expect(EVENT_TYPES).toContain('item.role-changed')
    expect([...WORK_EVENT_KINDS]).toContain('item.set-role')
    expect(INGEST_CONTRACT_VERSION).toBe('1.6.0')
    expect(READ_CONTRACT_VERSION).toBe('1.18.0')
  })
  it('isRoleContainer treats a stream as a container', () => {
    expect(isRoleContainer({ role: 'stream' })).toBe(true)
    expect(isRoleContainer({ role: 'workpackage' })).toBe(true)
    expect(isRoleContainer({ role: 'spec-phase' })).toBe(true)
    expect(isRoleContainer({})).toBe(false)
  })
})

// ---- 2. GATE: no-stream / no-role-change forest is BYTE-IDENTICAL ------------------------------

describe('A2 — GATE: a forest with NO stream numbers WP1..n exactly as before', () => {
  function buildWpOnlyForest(): { r1: Ulid; r2: Ulid; sp: Ulid; sub: Ulid } {
    const r1 = wp('Alpha')
    done(leaf('a-done', r1))
    leaf('a-todo', r1)
    const sp = phase('Phase', r1) // spec-phase ⇒ WP1.1
    done(leaf('p-done', sp))
    const sub = wp('Sub', r1) // sub-WP ⇒ WP1.2
    leaf('s-todo', sub)
    const r2 = wp('Beta')
    done(leaf('b-done', r2))
    return { r1, r2, sp, sub }
  }

  it('every label is the pre-codes positional derivation; NO node carries a role key', () => {
    const { r1, r2, sp, sub } = buildWpOnlyForest()
    expect(labelOf(r1)).toBe('WP1')
    expect(labelOf(r2)).toBe('WP2')
    const n1 = tree().find((n) => n.id === r1)!
    expect(n1.children.find((c) => c.id === sp)!.label).toBe('WP1.1')
    expect(n1.children.find((c) => c.id === sub)!.label).toBe('WP1.2')
    // additive-minimal: a workpackage/spec-phase node carries NO `role` key (byte-identical to pre-A2)
    const assertNoRoleKey = (nodes: typeof n1.children): void => {
      for (const n of nodes) {
        expect('role' in n).toBe(false)
        assertNoRoleKey(n.children)
      }
    }
    assertNoRoleKey(tree())
  })

  it('statusByLevel labels the WP roots WP1..n (unchanged)', () => {
    buildWpOnlyForest()
    const specs = statusByLevel(t.state(), 'spec', cfg)
    expect(specs.map((g) => g.label).sort()).toEqual(['WP1', 'WP2'])
  })
})

// ---- 3. stream numbering: S<n> (NOT WP<n>); WPs under a stream are relative (S1.1, S1.2) -------

describe('A2 — a stream root is labelled S<n>, not WP<n>', () => {
  it('a single stream root takes S1 (never WP1)', () => {
    const s1 = stream('Epic')
    expect(labelOf(s1)).toBe('S1')
  })

  it('a WP directly under a stream is S1.1 (relative), NOT a top-level WP<n>', () => {
    const s1 = stream('Epic')
    const w1 = wp('Wp-A', s1)
    const w2 = wp('Wp-B', s1)
    const node = tree().find((n) => n.id === s1)!
    expect(node.label).toBe('S1')
    expect(node.children.find((c) => c.id === w1)!.label).toBe('S1.1')
    expect(node.children.find((c) => c.id === w2)!.label).toBe('S1.2')
    // the WPs under the stream are NOT roots ⇒ they consume NO WP<n> ordinal.
    expect(tree().map((n) => n.id)).toEqual([s1])
  })

  it('WP roots and stream roots are numbered on SEPARATE sequences (WP1..n vs S1..m)', () => {
    const top = wp('TopWp') // id-0001 ⇒ WP1
    const s1 = stream('Epic1') // id-0002 ⇒ S1
    const inner = wp('Inner', s1) // under S1 ⇒ S1.1 (consumes NO WP ordinal)
    const s2 = stream('Epic2') // id-... ⇒ S2
    expect(labelOf(top)).toBe('WP1')
    expect(labelOf(s1)).toBe('S1')
    expect(labelOf(s2)).toBe('S2')
    expect(tree().find((n) => n.id === s1)!.children.find((c) => c.id === inner)!.label).toBe('S1.1')
  })

  it('the 7 DS streams render S1..S7, never WP1..WP7', () => {
    const ids = Array.from({ length: 7 }, (_, i) => stream(`Stream ${i + 1}`))
    const labels = ids.map(labelOf)
    expect(labels).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'])
    expect(labels.some((l) => l!.startsWith('WP'))).toBe(false)
  })

  it('statusByLevel partitions stream roots to S<n>', () => {
    const top = wp('TopWp')
    const s1 = stream('Epic')
    void top
    void s1
    const specs = statusByLevel(t.state(), 'spec', cfg)
    expect(specs.map((g) => g.label).sort()).toEqual(['S1', 'WP1'])
  })
})

// ---- 4. a stream is a CONTAINER, never a leaf -------------------------------------------------

describe('A2 — a stream counts as a container, not a leaf', () => {
  it('leaves under a stream→WP roll up; the stream itself is NOT a leaf', () => {
    const s1 = stream('Epic')
    const w1 = wp('Wp', s1)
    done(leaf('x', w1))
    leaf('y', w1)
    const sNode = tree().find((n) => n.id === s1)!
    // the stream node SUMS its descendant WP's leaves (1 done / 2 active)
    expect([sNode.done, sNode.active]).toEqual([1, 2])
  })

  it('a stream is absent from the flat buckets (container, not a leaf)', () => {
    const s1 = stream('Epic')
    const w1 = wp('Wp', s1)
    const l = leaf('leaf', w1)
    const report = t.report(base)
    const everyId = Object.values(report.buckets).flat().map((r) => r.id)
    expect(everyId).not.toContain(s1)
    expect(everyId).not.toContain(w1)
    expect(everyId).toContain(l)
  })

  it('queryable via query({role:"stream"}); excluded from the default flat query', () => {
    const s1 = stream('Epic')
    leaf('loose') // a top-level leaf — the only flat row
    const streams = t.query({ role: 'stream' }, base)
    expect(streams.map((r) => r.id)).toEqual([s1])
    expect(streams[0]!.role).toBe('stream')
    const flat = t.query({}, base)
    expect(flat.some((r) => r.id === s1)).toBe(false)
  })

  it('wpRootId is NEVER a stream — it climbs to the topmost workpackage UNDER the stream', () => {
    const s1 = stream('Epic')
    const w1 = wp('Wp', s1)
    const l = leaf('leaf', w1)
    expect(wpRootId(t.state().items, l)).toBe(w1) // the WP, never the stream
    expect(wpRootId(t.state().items, s1)).toBeUndefined() // a stream alone has no WP ancestor
  })
})

// ---- 5. assertRoleNesting — the stream clause -------------------------------------------------

describe('A2 — assertRoleNesting stream clause', () => {
  it('allows a workpackage under a stream', () => {
    expect(() => assertRoleNesting('workpackage', 'stream', 'c', 'p')).not.toThrow()
  })
  it('allows a stream under another stream; REJECTS a stream under a leaf parent (undefined here = leaf, never root)', () => {
    expect(() => assertRoleNesting('stream', 'stream', 'c', 'p')).not.toThrow()
    // assertRoleNesting is only ever called WITH an existing parent ⇒ `parentRole === undefined` means a
    // LEAF parent (a root container is legal precisely because its caller skips this check). So a stream
    // under a leaf must be rejected — NOT treated as a root.
    expect(() => assertRoleNesting('stream', undefined, 'c', 'p')).toThrow(DomainError)
  })
  it('REJECTS a stream under a workpackage (an epic does not nest under a WP)', () => {
    expect(() => assertRoleNesting('stream', 'workpackage', 'c', 'p')).toThrow(DomainError)
  })
  it('REJECTS a stream under a spec-phase', () => {
    expect(() => assertRoleNesting('stream', 'spec-phase', 'c', 'p')).toThrow(DomainError)
  })
  it('REJECTS a spec-phase under a stream (a spec-phase nests under a WP/spec-phase only)', () => {
    expect(() => assertRoleNesting('spec-phase', 'stream', 'c', 'p')).toThrow(DomainError)
  })

  it('createItem allows a WP under a stream; rejects a stream under a WP', () => {
    const s1 = stream('Epic')
    expect(() => wp('Wp', s1)).not.toThrow()
    const w = wp('TopWp')
    expect(() => stream('BadStream', w)).toThrow(/stream/)
  })
  it('reparent rejects moving a stream under a workpackage', () => {
    const s1 = stream('Epic')
    const w = wp('TopWp')
    expect(() => t.reparentItem(s1, w)).toThrow(DomainError)
  })
  it('createItem REJECTS a stream under a plain LEAF parent (not just under a WP)', () => {
    const lf = leaf('PlainLeaf')
    expect(() => stream('BadStream', lf)).toThrow(/stream/)
  })
  it('reparent REJECTS moving a stream under a plain LEAF parent', () => {
    const s1 = stream('Epic')
    const lf = leaf('PlainLeaf')
    expect(() => t.reparentItem(s1, lf)).toThrow(DomainError)
  })
  it('scopeValidate flags a (foreign-state) spec-phase under a STREAM as illegal-nesting (strict parent role, not isRoleContainer)', () => {
    // The write path forbids spec-phase-under-stream at create/reparent/setRole, so this only arises on a
    // hand-edited/foreign log. Simulate by folding a real log, then re-pointing the spec-phase's parent to
    // the stream, and assert scopeValidate surfaces it (stream is a container but NOT a legal spec-phase parent).
    const s = stream('Epic')
    const w = wp('Wp', s)
    const sp = phase('Phase', w) // legal: spec-phase under a WP
    const state = t.state()
    ;(state.items.get(sp) as { parentId?: Ulid }).parentId = s // foreign anomaly: spec-phase now under the stream
    const res = scopeValidate(state, { workspace: 'ws', baselineCommit: 'c1' })
    expect(res.findings.some((f) => f.code === 'illegal-nesting' && f.wpId === sp)).toBe(true)
  })
})

// ---- 6. setRole mutation (item.role-changed) — bounded container↔container --------------------

describe('A2 — setRole (item.role-changed): bounded container↔container with neighborhood re-validation', () => {
  it('promotes a top-level workpackage to a stream (fold LWW + S<n> render)', () => {
    const w = wp('WasWp')
    expect(labelOf(w)).toBe('WP1')
    t.setRole(w, 'stream')
    expect(t.state().items.get(w)!.role).toBe('stream')
    expect(labelOf(w)).toBe('S1') // re-numbered onto the stream sequence
    const evs = store.readAll().filter((e) => e.aggregateId === w)
    expect(evs.map((e) => [e.type, e.seq])).toEqual([
      ['item.created', 1],
      ['item.role-changed', 2],
    ])
    expect(integral()).toBe(true)
  })

  it('demotes a stream back to a workpackage (LWW, last write wins)', () => {
    const s = stream('Epic')
    t.setRole(s, 'workpackage')
    t.setRole(s, 'stream')
    expect(t.state().items.get(s)!.role).toBe('stream')
    expect(labelOf(s)).toBe('S1')
  })

  it('REJECTS changing the role of a non-container leaf (role undefined)', () => {
    const l = leaf('leaf')
    expect(() => t.setRole(l, 'stream')).toThrow(/workpackage or stream/)
  })

  it('REJECTS setRole on a spec-phase item (only workpackage↔stream are mutable)', () => {
    const w = wp('Wp')
    const sp = phase('Phase', w)
    expect(() => t.setRole(sp, 'stream')).toThrow(/workpackage or stream/)
  })

  it('REJECTS a target role that is not a container↔container target (spec-phase)', () => {
    const w = wp('Wp')
    expect(() => t.setRole(w, 'spec-phase' as never)).toThrow(DomainError)
  })

  it('REJECTS promoting a WP→stream when it has spec-phase children (nesting would break)', () => {
    const w = wp('Wp')
    const p = phase('Phase', w) // a spec-phase only nests under a WP/spec-phase
    void p
    const before = store.readAll().length
    expect(() => t.setRole(w, 'stream')).toThrow(/spec-phase/)
    // fail-closed: nothing appended, role unchanged
    expect(t.state().items.get(w)!.role).toBe('workpackage')
    expect(store.readAll().length).toBe(before)
  })

  it('REJECTS promoting a sub-WP (under a WP) to a stream (a stream cannot nest under a WP)', () => {
    const root = wp('Root')
    const sub = wp('Sub', root)
    expect(() => t.setRole(sub, 'stream')).toThrow(DomainError)
  })

  it('allows promoting a WP→stream whose children are WPs (a WP nests fine under a stream)', () => {
    const w = wp('Wp')
    const child = wp('Child', w)
    expect(() => t.setRole(w, 'stream')).not.toThrow()
    expect(t.state().items.get(w)!.role).toBe('stream')
    // the child WP is now relative under the stream
    expect(tree().find((n) => n.id === w)!.children.find((c) => c.id === child)!.label).toBe('S1.1')
  })

  it('rejects an unknown item', () => {
    expect(() => t.setRole('nope', 'stream')).toThrow(/unknown item/)
  })
})

// ---- 7. A1 code prioritaire on a stream (S<n> derivation yields to a code) ----------------------

describe('A2 — a coded stream renders its code verbatim (A1 code prioritaire over S<n>)', () => {
  it('assignCode accepts a stream; the code renders instead of S<n>', () => {
    const s1 = stream('Epic')
    t.assignCode(s1, 'CORE')
    expect(labelOf(s1)).toBe('CORE')
  })
  it('a `S5` code on a stream reserves ordinal 5 on the derived S sequence', () => {
    const s0 = stream('S0') // id-0001
    const s1 = stream('S1x') // id-0002
    t.assignCode(s1, 'S5')
    expect(labelOf(s0)).toBe('S1') // first uncoded stream
    expect(labelOf(s1)).toBe('S5') // verbatim
  })
})

// ---- 8. ingest seam — map + binding gate ------------------------------------------------------

describe('A2 — ingest seam (item.set-role)', () => {
  const ev = (kind: WorkEventKind, payload: Record<string, unknown>): WorkEvent => ({ v: 1, kind, payload })
  let n = 0
  const freshStore = (): EventStore => new EventStore(join(dir, `s${++n}`, '.track', 'events.jsonl'))
  const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({
    by: 'human:t',
    workspace: 'ws',
    prov: PROV,
    now,
    newId: counter(),
    ...over,
  })

  it('mapWorkEvent maps item.set-role → setRole (settles:always, args [itemId, to])', () => {
    const cmd = mapWorkEvent(ev('item.set-role', { itemId: 'i', to: 'stream' }))
    expect(cmd.method).toBe('setRole')
    expect(cmd.settles).toBe('always')
    expect(cmd.args).toEqual(['i', 'stream'])
  })

  it('rejects a bad `to` enum fail-closed (the mapper)', () => {
    expect(() => mapWorkEvent(ev('item.set-role', { itemId: 'i', to: 'spec-phase' }))).toThrow()
    expect(() => mapWorkEvent(ev('item.set-role', { itemId: 'i', to: 'leaf' }))).toThrow()
    expect(() => mapWorkEvent(ev('item.set-role', { itemId: 'i' }))).toThrow() // missing to
  })

  it('an authenticated channel changes a role via ingest', () => {
    const s = freshStore()
    const c = ctx()
    const id = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })], c, s).ids[0] as string
    ingest([ev('item.set-role', { itemId: id, to: 'stream' })], c, s)
    expect(new Track(s).state().items.get(id)!.role).toBe('stream')
  })

  it('an UNAUTHENTICATED channel is rejected (binding gate — settles:always)', () => {
    const s = freshStore()
    const id = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })], ctx(), s).ids[0] as string
    expect(() =>
      ingest(
        [ev('item.set-role', { itemId: id, to: 'stream' })],
        ctx({ prov: { transport: 'http', proposed: true, auth: 'unauthenticated' } }),
        s,
      ),
    ).toThrow()
    expect(new Track(s).state().items.get(id)!.role).toBe('workpackage') // unchanged
  })

  it('an item.create with role:stream is accepted via ingest', () => {
    const s = freshStore()
    const id = ingest([ev('item.create', { kind: 'chore', title: 'Epic', workspace: 'ws', role: 'stream' })], ctx(), s).ids[0] as string
    expect(new Track(s).state().items.get(id)!.role).toBe('stream')
  })
})
