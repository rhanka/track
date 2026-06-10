import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import type { Provenance, Ulid } from '../events/types.js'
import { bucketOf } from '../report/buckets.js'
import { fold } from '../state/fold.js'
import type { WorkEvent, WorkEventKind } from './contract.js'
import { ingest, type IngestContext } from './ingest.js'
import { IngestError } from './map.js'

const now = (): string => '2026-06-09T00:00:00.000Z'
const counter = (): (() => Ulid) => {
  let i = 0
  return () => `id-${String(++i).padStart(4, '0')}`
}
const SIGNED: Provenance = { transport: 'import', proposed: false, auth: 'signed' }
const LOCAL: Provenance = { transport: 'import', proposed: false, auth: 'local-user' }
const UNAUTH: Provenance = { transport: 'import', proposed: true, auth: 'unauthenticated' }
const ev = (kind: WorkEventKind, payload: Record<string, unknown>): WorkEvent => ({ v: 1, kind, payload })

let dir: string
let n = 0
const freshStore = (): EventStore => new EventStore(join(dir, `s${++n}`, '.track', 'events.jsonl'))
const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({ by: 'harness:t', workspace: 'ws', prov: SIGNED, ...over })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-verif-'))
  n = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const VRUN = { runId: 'vr-1', runner: 'stp-scope', commit: 'c1', verdict: 'clean' as const }

describe('VerificationRun ingestion — evidence-only (LOT 1)', () => {
  it('a SIGNED channel records a workspace-scoped VerificationRun (wpRef absent)', () => {
    const store = freshStore()
    ingest([ev('scope.verification', { ...VRUN })], ctx({ newId: counter(), now }), store)
    const state = fold(store.readAll())
    const run = state.verificationRuns.get('vr-1')
    expect(run).toMatchObject({ runId: 'vr-1', runner: 'stp-scope', commit: 'c1', verdict: 'clean', at: now() })
    expect(store.readAll().filter((e) => e.type === 'scope.verification-recorded').length).toBe(1)
  })

  it('a LOCAL-user channel records a VerificationRun on a wpRef item aggregate', () => {
    const store = freshStore()
    const wpRef = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })], ctx({ prov: LOCAL }), store).ids[0]!
    ingest([ev('scope.verification', { ...VRUN, runId: 'vr-2', wpRef, verdict: 'violation', violations: ['src/forbidden.ts'] })], ctx({ prov: LOCAL }), store)
    const state = fold(store.readAll())
    const run = state.verificationRuns.get('vr-2')
    expect(run).toMatchObject({ wpRef, verdict: 'violation', violations: ['src/forbidden.ts'] })
    // recorded on the item aggregate (next seq), not a synthetic one
    const recorded = store.readAll().find((e) => e.type === 'scope.verification-recorded')!
    expect(recorded.aggregate).toBe('item')
    expect(recorded.aggregateId).toBe(wpRef)
  })

  it('an UNAUTHENTICATED channel is REJECTED (Settles:evidence — like acceptance.run)', () => {
    const store = freshStore()
    const before = store.readAll().length
    expect(() => ingest([ev('scope.verification', { ...VRUN })], ctx({ prov: UNAUTH }), store)).toThrow(IngestError)
    expect(() => ingest([ev('scope.verification', { ...VRUN })], ctx({ prov: UNAUTH }), store)).toThrow(/binding write and requires an authenticated channel/)
    expect(store.readAll().length).toBe(before) // nothing written
  })

  it('a `violation` verdict does NOT change any item bucket/realization (evidence NEVER becomes an item)', () => {
    const store = freshStore()
    const wpRef = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })], ctx({ prov: LOCAL }), store).ids[0]!
    const leaf = ingest([ev('item.create', { kind: 'feature', title: 'L', workspace: 'ws', parentId: wpRef })], ctx({ prov: LOCAL }), store).ids[0]!
    const config = { baselineCommit: 'c1', requireAccepted: false }
    const bucketBefore = bucketOf(fold(store.readAll()), fold(store.readAll()).items.get(leaf)!, config)
    const realizationBefore = fold(store.readAll()).items.get(leaf)!.realization
    const lenBefore = store.readAll().filter((e) => e.aggregate === 'item').length

    ingest([ev('scope.verification', { ...VRUN, runId: 'vr-3', wpRef, verdict: 'violation', violations: ['src/x.ts', 'src/y.ts'] })], ctx({ prov: LOCAL }), store)

    const after = fold(store.readAll())
    expect(bucketOf(after, after.items.get(leaf)!, config)).toBe(bucketBefore) // bucket unchanged
    expect(after.items.get(leaf)!.realization).toBe(realizationBefore) // realization unchanged
    // No new ITEM-mutating event: the recorded event lives on the WP aggregate but folds ONLY into
    // verificationRuns — no spec/realization/blocker change on any item.
    expect(after.verificationRuns.size).toBe(1)
    expect(after.items.size).toBe(2) // still just WP + leaf
    // item-aggregate event count grew by exactly 1 (the verification-recorded on the WP) and it changed nothing.
    expect(store.readAll().filter((e) => e.aggregate === 'item').length).toBe(lenBefore + 1)
  })

  it('workspace containment: a W-pinned channel cannot record a VerificationRun for a V wpRef', () => {
    const store = freshStore()
    const vWp = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'V', role: 'workpackage' })], ctx({ workspace: 'V', prov: LOCAL }), store).ids[0]!
    const before = store.readAll().length
    expect(() =>
      ingest([ev('scope.verification', { ...VRUN, runId: 'vr-4', wpRef: vWp })], ctx({ workspace: 'W', prov: LOCAL }), store),
    ).toThrow(/belongs to workspace "V"/)
    expect(store.readAll().length).toBe(before)
  })

  it('clientToken idempotency: a re-ingested run with the same token is a no-op', () => {
    const store = freshStore()
    const stream = [{ v: 1 as const, kind: 'scope.verification' as const, payload: { ...VRUN, runId: 'vr-5' }, clientToken: 'tok-1' }]
    ingest(stream, ctx(), store)
    ingest(stream, ctx(), store)
    expect(store.readAll().filter((e) => e.type === 'scope.verification-recorded').length).toBe(1)
  })

  it('additive hash-stability: pre-verification logs hash-identically; scope.verification-recorded absent', () => {
    // A log built WITHOUT any verification has byte-identical events whether or not the feature exists.
    const a = freshStore()
    ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx({ newId: counter(), now, prov: LOCAL }), a)
    const events = a.readAll()
    expect(events.every((e) => e.type !== 'scope.verification-recorded')).toBe(true)
    // contentHash is deterministic over the core — recompute via a fresh store with the SAME inputs.
    const b = freshStore()
    ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx({ newId: counter(), now, prov: LOCAL }), b)
    expect(b.readAll()).toEqual(events) // hash/seq identical — verification is purely additive
  })
})
