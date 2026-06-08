import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from './events/store.js'
import type { Provenance } from './events/types.js'
import type { WorkEventKind } from './ingest/contract.js'
import { ingest, type IngestContext } from './ingest/ingest.js'
import { dispatchReadTool } from './mcp/server.js'
import { TrackReader } from './read/contract.js'

// The bridge's signed channel (it verified the h2a engagement settled, then writes the resolve).
const BRIDGE: Provenance = { transport: 'http', proposed: false, auth: 'signed', principal: 'bridge:h2a', sig: { alg: 'Ed25519', value: 'c2ln', by: 'nhi-bridge' } }
const LOCAL: Provenance = { transport: 'cli', proposed: false, auth: 'local-user' }
const ev = (kind: WorkEventKind, payload: Record<string, unknown>) => ({ v: 1 as const, kind, payload })

let dir: string
let store: EventStore
let reader: TrackReader

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-lotc-'))
  const eventsPath = join(dir, '.track', 'events.jsonl')
  store = new EventStore(eventsPath)
  reader = new TrackReader(eventsPath)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Lot C — h2a bridge: a signed channel resolves an EXTERNAL dependency when its engagement settles', () => {
  const localCtx: IngestContext = { by: 'human:x', workspace: 'ws', prov: LOCAL }
  const bridgeCtx: IngestContext = { by: 'bridge:h2a', workspace: 'ws', prov: BRIDGE }

  it('open extra dep → reader.externalDependencies finds it → signed blocker.resolve clears it', () => {
    // 1) a local user opens an EXTERNAL dependency on item A, referencing an h2a ENGAGEMENT
    const item = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], localCtx, store).ids[0]!
    const blk = ingest([ev('blocker.raise', { targetId: item, kind: 'dependency', scope: 'extra', engagementRef: 'eng-42', reason: 'awaits cross-repo X' })], localCtx, store).ids[0]!

    // item A is AWAITED, and the bridge can SEE the open external dep (the read surface it watches)
    expect(reader.report({ baselineCommit: 'c1' }).buckets.AWAITED.map((r) => r.id)).toContain(item)
    const ext = reader.externalDependencies()
    expect(ext.length).toBe(1)
    expect(ext[0]).toMatchObject({ blockerId: blk, targetId: item, engagementRef: 'eng-42' })
    expect(typeof ext[0]!.openedAt).toBe('string')

    // 2) the h2a engagement settles → the BRIDGE (a signed channel) resolves the dep it found
    ingest([ev('blocker.resolve', { blockerId: ext[0]!.blockerId })], bridgeCtx, store)

    // 3) item A unblocks; no open external deps remain; the resolve is recorded with auth:'signed' + principal
    expect(reader.report({ baselineCommit: 'c1' }).buckets.AWAITED.map((r) => r.id)).not.toContain(item)
    expect(reader.externalDependencies()).toEqual([])
    const resolved = store.readAll().find((e) => e.type === 'blocker.resolved')!
    expect((resolved.prov as Provenance).auth).toBe('signed')
    expect((resolved.prov as Provenance).principal).toBe('bridge:h2a')
    expect((resolved.payload as { engagementRef?: string }).engagementRef).toBe('eng-42') // audit correlation on the resolve
    expect(reader.validate().ok).toBe(true)
  })

  it('externalDependencies excludes intra dependencies', () => {
    const a = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], localCtx, store).ids[0]!
    const b = ingest([ev('item.create', { kind: 'feature', title: 'B', workspace: 'ws' })], localCtx, store).ids[0]!
    ingest([ev('blocker.raise', { targetId: a, kind: 'dependency', ref: b, resolutionRule: 'manual', reason: '' })], localCtx, store)
    expect(reader.externalDependencies()).toEqual([]) // an intra (local-ref) dep is not external
  })

  it('one engagement blocking N items → externalDependencies returns all; the bridge resolves each by blockerId', () => {
    const a = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], localCtx, store).ids[0]!
    const b = ingest([ev('item.create', { kind: 'feature', title: 'B', workspace: 'ws' })], localCtx, store).ids[0]!
    ingest([ev('blocker.raise', { targetId: a, kind: 'dependency', scope: 'extra', engagementRef: 'eng-shared', reason: '' })], localCtx, store)
    ingest([ev('blocker.raise', { targetId: b, kind: 'dependency', scope: 'extra', engagementRef: 'eng-shared', reason: '' })], localCtx, store)
    const pending = reader.externalDependencies().filter((d) => d.engagementRef === 'eng-shared')
    expect(pending.length).toBe(2) // both items' deps surface; the bridge resolves each (no bulk primitive needed)
    for (const d of pending) ingest([ev('blocker.resolve', { blockerId: d.blockerId })], bridgeCtx, store)
    expect(reader.externalDependencies()).toEqual([])
    const awaited = reader.report({ baselineCommit: 'c1' }).buckets.AWAITED.map((r) => r.id)
    expect(awaited).not.toContain(a)
    expect(awaited).not.toContain(b)
  })

  it('a signed bridge pinned to W CANNOT resolve an extra dep whose target is in V (containment holds)', () => {
    const vItem = ingest([ev('item.create', { kind: 'feature', title: 'V', workspace: 'V' })], { by: 'human:x', workspace: 'V', prov: LOCAL }, store).ids[0]!
    const vBlk = ingest([ev('blocker.raise', { targetId: vItem, kind: 'dependency', scope: 'extra', engagementRef: 'eng-V', reason: '' })], { by: 'human:x', workspace: 'V', prov: LOCAL }, store).ids[0]!
    expect(() => ingest([ev('blocker.resolve', { blockerId: vBlk })], { by: 'bridge:h2a', workspace: 'W', prov: BRIDGE }, store)).toThrow(/belongs to workspace "V"/)
  })

  it('the track_external_deps MCP tool returns the library result (read-only parity)', () => {
    const item = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], localCtx, store).ids[0]!
    ingest([ev('blocker.raise', { targetId: item, kind: 'dependency', scope: 'extra', engagementRef: 'eng-mcp', reason: '' })], localCtx, store)
    const before = store.readAll().length
    const out = JSON.parse(dispatchReadTool(reader, 'track_external_deps', {}))
    expect(out).toEqual(reader.externalDependencies()) // byte-parity with the library surface
    expect(store.readAll().length).toBe(before) // side-effect-free
  })
})
