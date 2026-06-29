import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from './events/store.js'
import type { Provenance, Ulid } from './events/types.js'
import { DomainError } from './model/item.js'
import { Track } from './track.js'
import { ingest, type IngestContext } from './ingest/ingest.js'
import { IngestError } from './ingest/map.js'
import type { WorkEvent, WorkEventKind } from './ingest/contract.js'

// Cross-workspace WP reorg (DESIGN v2) — Lot 1 R2 capability + restructureReparent (C4) + R2b portée plan.
// The LOAD-BEARING security property: an ORDINARY channel can NEVER move work across workspaces; only an
// explicitly-granted `item.restructure` channel can. Threat model (DESIGN §MODÈLE DE MENACE): defends the
// accidental/automated cross-workspace crossing, NOT a malicious local process (which can call the facade
// restructureReparent directly — unchanged vs today, like any local-user binding write).

const PROV: Provenance = { transport: 'import', proposed: false, auth: 'local-user' }

let dir: string
function freshStore(): EventStore {
  return new EventStore(join(dir, '.track', 'events.jsonl'))
}
function counter(): () => Ulid {
  let i = 0
  return () => `id-${String(++i).padStart(4, '0')}`
}
function trackOn(store: EventStore): Track {
  let n = 0
  return new Track(store, { by: 'tester', prov: PROV, now: () => '2026-06-29T00:00:00.000Z', newId: () => `t-${String(++n).padStart(4, '0')}` })
}
const ev = (kind: WorkEventKind, payload: Record<string, unknown>, clientToken?: string): WorkEvent => ({
  v: 1,
  kind,
  payload,
  ...(clientToken !== undefined ? { clientToken } : {}),
})
const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({ by: 'human:t', workspace: 'V', prov: PROV, ...over })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-restructure-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('restructureReparent (facade) — C4: skips ONLY the 267 cross-workspace guard', () => {
  it('moves a child under a parent in ANOTHER workspace (the 267 guard is skipped)', () => {
    const store = freshStore()
    const t = trackOn(store)
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    t.restructureReparent(child, wpW, 'plan-h1')
    expect(t.state().items.get(child)!.parentId).toBe(wpW)
    // workspace is IMMUTABLE — the child STAYS in V even after the cross-workspace move (DESIGN §Décision).
    expect(t.state().items.get(child)!.workspace).toBe('V')
  })

  it('reuses item.reparented (R6) — NO new event type; payload carries planHash additively', () => {
    const store = freshStore()
    const t = trackOn(store)
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    t.restructureReparent(child, wpW, 'plan-h1', 'ref-7')
    const reparented = store.readAll().filter((e) => e.type === 'item.reparented')
    expect(reparented.length).toBe(1)
    expect(store.readAll().some((e) => (e.type as string) === 'item.restructured')).toBe(false)
    expect(reparented[0]!.payload).toMatchObject({ parentId: wpW, planHash: 'plan-h1', restructureRef: 'ref-7' })
  })

  it('STILL rejects a self-parent (262-266 preserved)', () => {
    const store = freshStore()
    const t = trackOn(store)
    const a = t.createItem({ kind: 'chore', title: 'a', workspace: 'V' })
    expect(() => t.restructureReparent(a, a, 'p')).toThrow(DomainError)
  })

  it('STILL rejects an unknown item / unknown parent (262-266 preserved)', () => {
    const store = freshStore()
    const t = trackOn(store)
    const a = t.createItem({ kind: 'chore', title: 'a', workspace: 'V' })
    expect(() => t.restructureReparent('nope', a, 'p')).toThrow(/unknown item/)
    expect(() => t.restructureReparent(a, 'nope', 'p')).toThrow(/unknown parent/)
  })

  it('STILL enforces role-nesting (276): a workpackage may not nest under a non-WP, even cross-workspace', () => {
    const store = freshStore()
    const t = trackOn(store)
    const leafW = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'W' })
    const wpV = t.createItem({ kind: 'chore', title: 'WP', workspace: 'V', role: 'workpackage' })
    expect(() => t.restructureReparent(wpV, leafW, 'p')).toThrow(/workpackage may only nest under a workpackage/)
  })

  it('STILL enforces the cycle-walk (277-283): no reparent under a transitive descendant', () => {
    const store = freshStore()
    const t = trackOn(store)
    // all workpackages so role-nesting PASSES and the cycle-walk is the guard that fires (a→b→c→a).
    const a = t.createItem({ kind: 'chore', title: 'a', workspace: 'V', role: 'workpackage' })
    const b = t.createItem({ kind: 'chore', title: 'b', workspace: 'V', role: 'workpackage', parentId: a })
    const c = t.createItem({ kind: 'chore', title: 'c', workspace: 'V', role: 'workpackage', parentId: b })
    expect(() => t.restructureReparent(a, c, 'p')).toThrow(/cycle/)
  })
})

describe('reparentItem (facade) — UNCHANGED: 267 cross-workspace guard stays UNCONDITIONAL', () => {
  it('still rejects an ordinary cross-workspace reparent (the 267 guard is intact)', () => {
    const store = freshStore()
    const t = trackOn(store)
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    expect(() => t.reparentItem(child, wpW)).toThrow(/cannot reparent across workspaces/)
  })
})

describe('authorize (seam) — R2: item.restructure is DEFAULT-DENIED (deny-explicit branch)', () => {
  it('REJECTS item.restructure when the channel does NOT explicitly grant it (even with allowedKinds unset)', () => {
    const store = freshStore()
    const t = trackOn(store)
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    const before = store.readAll().length
    // allowedKinds UNSET (the prod default that permits everything) — restructure must STILL be denied.
    expect(() => ingest([ev('item.restructure', { itemId: child, parentId: wpW, planHash: 'h' })], ctx({ workspace: 'V' }), store)).toThrow(IngestError)
    expect(() => ingest([ev('item.restructure', { itemId: child, parentId: wpW, planHash: 'h' })], ctx({ workspace: 'V' }), store)).toThrow(/restructure/i)
    expect(store.readAll().length).toBe(before) // nothing written — fail-closed
  })

  it('REJECTS item.restructure when allowedKinds is set but omits it', () => {
    const store = freshStore()
    const t = trackOn(store)
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    expect(() =>
      ingest([ev('item.restructure', { itemId: child, parentId: wpW, planHash: 'h' })], ctx({ workspace: 'V', allowedKinds: new Set<WorkEventKind>(['item.reparent']) }), store),
    ).toThrow(IngestError)
  })
})

// ---- LE TEST CENTRAL (Q7) -------------------------------------------------------------------------
describe('Q7 — ordinary reparent rejected at BOTH layers; granted restructure authorized', () => {
  it('ordinary cross-workspace reparent is REJECTED at the FACADE layer (track.ts:267)', () => {
    const store = freshStore()
    const t = trackOn(store)
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    expect(() => t.reparentItem(child, wpW)).toThrow(DomainError)
  })

  it('ordinary cross-workspace reparent is REJECTED at the SEAM layer (item.reparent kind, parent containment)', () => {
    const store = freshStore()
    const t = trackOn(store)
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    const before = store.readAll().length
    // An ordinary channel pinned to V tries to pull the child under a W parent via the ORDINARY kind.
    expect(() => ingest([ev('item.reparent', { itemId: child, parentId: wpW })], ctx({ workspace: 'V' }), store)).toThrow(IngestError)
    expect(() => ingest([ev('item.reparent', { itemId: child, parentId: wpW })], ctx({ workspace: 'V' }), store)).toThrow(/workspace "W"/)
    expect(store.readAll().length).toBe(before)
  })

  it('a GRANTED restructure channel (kind granted + planHash) IS authorized cross-workspace', () => {
    const store = freshStore()
    const t = trackOn(store)
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    const res = ingest(
      [ev('item.restructure', { itemId: child, parentId: wpW, planHash: 'h1' })],
      ctx({ workspace: 'V', allowedKinds: new Set<WorkEventKind>(['item.restructure']) }),
      store,
    )
    expect(res.count).toBe(1)
    const after = new Track(store, { by: 't', prov: PROV }).state()
    expect(after.items.get(child)!.parentId).toBe(wpW) // moved under the foreign-workspace WP
    expect(after.items.get(child)!.workspace).toBe('V') // workspace immutable
  })

  it('a granted restructure channel pinned to V can NOT move a FOREIGN child (child pinned to ctx.workspace, R2b)', () => {
    const store = freshStore()
    const t = trackOn(store)
    const wpV = t.createItem({ kind: 'chore', title: 'WP-V', workspace: 'V', role: 'workpackage' })
    const foreignChild = t.createItem({ kind: 'chore', title: 'x', workspace: 'X' })
    const before = store.readAll().length
    // The channel grants restructure AND pins to V, but the child is in X ⇒ the seam pins the CHILD to
    // ctx.workspace ⇒ rejected (a V-channel can only pull-into/push-out-of V, never rearrange foreign X↔Y).
    expect(() =>
      ingest([ev('item.restructure', { itemId: foreignChild, parentId: wpV, planHash: 'h' })], ctx({ workspace: 'V', allowedKinds: new Set<WorkEventKind>(['item.restructure']) }), store),
    ).toThrow(IngestError)
    expect(store.readAll().length).toBe(before)
  })

  it('a granted restructure channel still requires an AUTHENTICATED channel (binding gate, secondary)', () => {
    const store = freshStore()
    const t = trackOn(store)
    const wpW = t.createItem({ kind: 'chore', title: 'WP-W', workspace: 'W', role: 'workpackage' })
    const child = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'V' })
    const unauth: Provenance = { transport: 'import', proposed: true, auth: 'unauthenticated' }
    expect(() =>
      ingest([ev('item.restructure', { itemId: child, parentId: wpW, planHash: 'h' })], ctx({ workspace: 'V', prov: unauth, allowedKinds: new Set<WorkEventKind>(['item.restructure']) }), store),
    ).toThrow(/binding write and requires an authenticated channel/)
  })
})
