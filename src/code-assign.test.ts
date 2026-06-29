// WP-codes (DESIGN wp-codes-and-stream-role A1, KEYSTONE) — a DURABLE, re-assignable display `code` on a
// role-container that DECOUPLES stability from the derived `WP<n>` numbering. A1 ONLY (no role:'stream', no
// terminal-exclusion). Covers: the new additive `item.code-assigned` event (fold/map/ingest/back-compat),
// the `assignCode` facade (role-container + non-empty + roster-global uniqueness, LWW), the binding gate,
// and the PRINCIPE PORTEUR — the derived counter SKIPS any ordinal a `^WP\d+$` code claims.

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
import { INGEST_CONTRACT_VERSION, WORK_EVENT_KINDS } from './ingest/contract.js'
import type { WorkEvent, WorkEventKind } from './ingest/contract.js'
import { mapWorkEvent } from './ingest/map.js'
import { DomainError } from './model/item.js'
import { computeWpTree, wpRootId } from './report/rollup.js'
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-code-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  store = new EventStore(eventsPath)
  // Injected counter ids ⇒ deterministic ULID order (roots sort by id) for the skip-derivation tests.
  t = new Track(store, { by: 'human:x', now, newId: counter() })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const integral = (): boolean => validate(store.readAll(), readHead(eventsPath)).ok
const wp = (title: string): Ulid => t.createItem({ kind: 'chore', title, workspace: 'ws', role: 'workpackage' })
const leaf = (title: string, parentId: Ulid): Ulid => t.createItem({ kind: 'chore', title, workspace: 'ws', parentId })
const done = (id: Ulid): void => {
  t.setRealization(id, 'in-progress')
  t.setRealization(id, 'done')
}
const tree = () => computeWpTree(t.state(), cfg)
const labelOf = (id: Ulid): string | undefined => tree().find((n) => n.id === id)?.label

// ---- 1. enum / contract pins -------------------------------------------------------------------

describe('WP-codes A1 — contract pins', () => {
  it('pins the new event-type + work-event-kind names and the INGEST minor bump', () => {
    expect(EVENT_TYPES).toContain('item.code-assigned')
    expect([...WORK_EVENT_KINDS]).toContain('item.assign-code')
    expect(INGEST_CONTRACT_VERSION).toBe('1.5.0')
  })
})

// ---- 2. assignCode facade --------------------------------------------------------------------

describe('WP-codes A1 — assignCode facade', () => {
  it('folds item.code (LWW) and appends item.code-assigned on the EXISTING aggregate (next seq)', () => {
    const a = wp('Alpha')
    t.assignCode(a, 'WP-AUTH')
    expect(t.state().items.get(a)!.code).toBe('WP-AUTH')
    const evs = store.readAll().filter((e) => e.aggregateId === a)
    expect(evs.map((e) => [e.type, e.seq])).toEqual([
      ['item.created', 1],
      ['item.code-assigned', 2],
    ])
    expect(integral()).toBe(true)
  })

  it('renders the code VERBATIM as the report label', () => {
    const a = wp('Alpha')
    t.assignCode(a, 'AUTH')
    expect(labelOf(a)).toBe('AUTH')
  })

  it('assigns a code to a ROOT spec-phase too', () => {
    const p = t.createItem({ kind: 'chore', title: 'Phase', workspace: 'ws', role: 'spec-phase' })
    t.assignCode(p, 'PH')
    expect(labelOf(p)).toBe('PH')
  })

  it('rejects an unknown item', () => {
    expect(() => t.assignCode('nope', 'X')).toThrow(DomainError)
  })

  it('rejects a non-container leaf', () => {
    const a = wp('Alpha')
    const l = leaf('leaf', a)
    expect(() => t.assignCode(l, 'X')).toThrow(/only assignable to a workpackage or spec-phase/)
  })

  it('rejects an empty code', () => {
    const a = wp('Alpha')
    expect(() => t.assignCode(a, '')).toThrow(/non-empty/)
  })

  it('LWW — re-assigning a code, last wins (fold + render)', () => {
    const a = wp('Alpha')
    t.assignCode(a, 'OLD')
    t.assignCode(a, 'NEW')
    expect(t.state().items.get(a)!.code).toBe('NEW')
    expect(labelOf(a)).toBe('NEW')
    // two events, contiguous seq, intact integrity
    const types = store.readAll().filter((e) => e.aggregateId === a).map((e) => e.type)
    expect(types).toEqual(['item.created', 'item.code-assigned', 'item.code-assigned'])
    expect(integral()).toBe(true)
  })

  it('re-assigning the SAME code to the SAME item is not a uniqueness collision', () => {
    const a = wp('Alpha')
    t.assignCode(a, 'X')
    expect(() => t.assignCode(a, 'X')).not.toThrow()
    expect(t.state().items.get(a)!.code).toBe('X')
  })
})

// ---- 3. roster-global uniqueness (+ the under-lock recheck rule) --------------------------------

describe('WP-codes A1 — roster-global uniqueness', () => {
  it('rejects a SECOND root container reusing a code (DomainError), appends nothing', () => {
    const a = wp('Alpha')
    const b = wp('Beta')
    t.assignCode(a, 'DUP')
    const before = store.readAll().length
    expect(() => t.assignCode(b, 'DUP')).toThrow(/roster-global unique/)
    expect(t.state().items.get(b)!.code).toBeUndefined()
    expect(store.readAll().length).toBe(before) // no event for b
  })

  it('re-reads the CURRENT log on each attempt (the same assertion the under-lock F2 recheck runs)', () => {
    // A fresh Track over the SAME store (simulating another writer) sees the committed code and is rejected
    // — exactly what the appendCommand `recheck` re-asserts under the lock against the now-current fold.
    const a = wp('Alpha')
    const b = wp('Beta')
    t.assignCode(a, 'DUP')
    const t2 = new Track(store, { by: 'human:y', now, newId: counter() })
    expect(() => t2.assignCode(b, 'DUP')).toThrow(/roster-global unique/)
  })

  it('rejects a code already held by a SUB-WP (a root + a sub-WP cannot share — widened scan)', () => {
    // The asymmetry the gate flagged: the EXISTING holder is a NESTED sub-WP, not a root. The old root-only
    // scan missed this; the widened scan rejects the second container (here a root) reusing the sub-WP's code.
    const a = wp('Alpha') // root
    const subA = t.createItem({ kind: 'chore', title: 'Sub', workspace: 'ws', role: 'workpackage', parentId: a })
    t.assignCode(subA, 'DUP') // the code lives on a SUB-WP
    const b = wp('Beta') // another root
    const before = store.readAll().length
    expect(() => t.assignCode(b, 'DUP')).toThrow(/roster-global unique/)
    expect(t.state().items.get(b)!.code).toBeUndefined()
    expect(store.readAll().length).toBe(before) // nothing appended for b
  })
})

// ---- 4. PRINCIPE PORTEUR — derived counter SKIPS coded ordinals ---------------------------------

describe('WP-codes A1 — derived `WP<n>` SKIPS ordinals claimed by a code', () => {
  it('a mid-roster code "WP5" → no-code roots take WP1, WP2 (verbatim WP5 between)', () => {
    const r0 = wp('R0') // id-0001
    const r1 = wp('R1') // id-0002
    const r2 = wp('R2') // id-0003
    t.assignCode(r1, 'WP5')
    expect(labelOf(r0)).toBe('WP1')
    expect(labelOf(r1)).toBe('WP5')
    expect(labelOf(r2)).toBe('WP2')
  })

  it('a code "WP1" on a LATE root forces the others to NOT reuse WP1', () => {
    const r0 = wp('R0')
    const r1 = wp('R1')
    const r2 = wp('R2')
    t.assignCode(r2, 'WP1') // claims ordinal 1 even though r2 sorts last
    expect(labelOf(r0)).toBe('WP2')
    expect(labelOf(r1)).toBe('WP3')
    expect(labelOf(r2)).toBe('WP1')
  })

  it('an all-coded roster renders exactly its codes', () => {
    const r0 = wp('R0')
    const r1 = wp('R1')
    t.assignCode(r0, 'ALPHA')
    t.assignCode(r1, 'BETA')
    expect(tree().map((n) => n.label).sort()).toEqual(['ALPHA', 'BETA'])
  })

  it('a non-`WP<n>` code reserves NO ordinal (the derived sequence is unaffected)', () => {
    const r0 = wp('R0')
    const r1 = wp('R1')
    t.assignCode(r0, 'AUTH') // does not match ^WP\d+$
    expect(labelOf(r0)).toBe('AUTH')
    expect(labelOf(r1)).toBe('WP1') // NOT skipped — AUTH claims no ordinal
  })

  it('a SUB-WP coded "WP5" reserves ordinal 5 at the uncoded ROOTS (widened claimed scan)', () => {
    const r0 = wp('R0') // id-0001
    const r1 = wp('R1') // id-0002
    const r2 = wp('R2') // id-0003
    const r3 = wp('R3') // id-0004
    const r4 = wp('R4') // id-0005
    const sub = t.createItem({ kind: 'chore', title: 'Sub', workspace: 'ws', role: 'workpackage', parentId: r0 }) // id-0006
    t.assignCode(sub, 'WP5') // a coded SUB-WP claims root ordinal 5 (it renders "WP5" verbatim, same class)
    // the uncoded roots SKIP ordinal 5 — the fifth root jumps to WP6, no display collision with the sub's WP5.
    expect([r0, r1, r2, r3, r4].map(labelOf)).toEqual(['WP1', 'WP2', 'WP3', 'WP4', 'WP6'])
  })

  it('exposes node.code ONLY when present (drop-when-absent)', () => {
    const r0 = wp('R0')
    const r1 = wp('R1')
    t.assignCode(r0, 'X')
    const n0 = tree().find((n) => n.id === r0)!
    const n1 = tree().find((n) => n.id === r1)!
    expect(n0.code).toBe('X')
    expect('code' in n1).toBe(false)
  })
})

// ---- 5. codes are DISPLAY-only, never identity --------------------------------------------------

describe('WP-codes A1 — a code is a display label, never an identity', () => {
  it('a code does NOT change buckets/counts (display-only)', () => {
    const a = wp('Alpha')
    const d = leaf('d', a)
    leaf('t', a)
    done(d)
    const beforeNode = tree().find((n) => n.id === a)!
    const snapshot = [beforeNode.done, beforeNode.active, beforeNode.dropped, beforeNode.pct]
    t.assignCode(a, 'WP-X')
    const afterNode = tree().find((n) => n.id === a)!
    expect([afterNode.done, afterNode.active, afterNode.dropped, afterNode.pct]).toEqual(snapshot)
  })

  it('wpRootId stays the ULID after a recode (never the code) — codes are not refs', () => {
    const a = wp('Alpha')
    const l = leaf('x', a)
    t.assignCode(a, 'WP-X')
    expect(wpRootId(t.state().items, l)).toBe(a) // the ULID, NOT 'WP-X'
  })
})

// ---- 6. ingest seam (map + binding gate + back-compat) ------------------------------------------

describe('WP-codes A1 — ingest seam', () => {
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

  it('mapWorkEvent maps item.assign-code → assignCode (settles:always, args [itemId, code])', () => {
    const cmd = mapWorkEvent(ev('item.assign-code', { itemId: 'i', code: 'C' }))
    expect(cmd.method).toBe('assignCode')
    expect(cmd.settles).toBe('always')
    expect(cmd.args).toEqual(['i', 'C'])
  })

  it('rejects a missing required field fail-closed (the mapper)', () => {
    expect(() => mapWorkEvent(ev('item.assign-code', { itemId: 'i' }))).toThrow() // missing code
    expect(() => mapWorkEvent(ev('item.assign-code', { code: 'C' }))).toThrow() // missing itemId
  })

  it('an authenticated channel assigns a code via ingest', () => {
    const s = freshStore()
    const c = ctx()
    const id = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })], c, s).ids[0] as string
    ingest([ev('item.assign-code', { itemId: id, code: 'WP-A' })], c, s)
    expect(new Track(s).state().items.get(id)!.code).toBe('WP-A')
  })

  it('an UNAUTHENTICATED channel is rejected (binding gate — settles:always)', () => {
    const s = freshStore()
    const id = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })], ctx(), s).ids[0] as string
    expect(() =>
      ingest(
        [ev('item.assign-code', { itemId: id, code: 'WP-A' })],
        ctx({ prov: { transport: 'http', proposed: true, auth: 'unauthenticated' } }),
        s,
      ),
    ).toThrow()
    // nothing committed for the code
    expect(new Track(s).state().items.get(id)!.code).toBeUndefined()
  })

  it('back-compat: the code event leaves integrity intact and never enters a bucket (display-only)', () => {
    const s = freshStore()
    const c = ctx()
    const id = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })], c, s).ids[0] as string
    ingest([ev('item.assign-code', { itemId: id, code: 'WP-A' })], c, s)
    expect(validate(s.readAll(), readHead(join(dir, `s${n}`, '.track', 'events.jsonl'))).ok).toBe(true)
    // a container is never a flat bucket leaf; the code adds no row — the report buckets stay empty of it.
    const report = new Track(s).report({ baselineCommit: 'c1' })
    const allRows = [...report.buckets.AWAITED, ...report.buckets['TO-DO'], ...report.buckets.DONE, ...report.buckets.DROPPED]
    expect(allRows.some((r) => r.id === id)).toBe(false)
  })
})
