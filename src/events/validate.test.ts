import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { canonicalize } from './canonical.js'
import { contentHashOf } from './frame.js'
import { readHead } from './head.js'
import { EventStore } from './store.js'
import type { CommandEvent, EventCore, Sha256, TrackEvent } from './types.js'
import { validate } from './validate.js'

let dir: string
let store: EventStore
let eventsPath: string
let counter: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-validate-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  store = new EventStore(eventsPath)
  counter = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function evt(over: Partial<CommandEvent> = {}): CommandEvent {
  counter += 1
  return {
    id: `evt-${String(counter).padStart(4, '0')}`,
    type: 'item.created',
    aggregate: 'item',
    aggregateId: 'item-A',
    at: `2026-06-03T10:00:${String(counter).padStart(2, '0')}.000Z`,
    by: 'tester',
    payload: { k: counter },
    ...over,
  }
}

// Build a valid integrity-framed chain from cores (mirrors the store) for hand-crafted cases.
function chain(cores: EventCore[]): TrackEvent[] {
  let prevHash: Sha256 | null = null
  const seqByAgg = new Map<string, number>()
  return cores.map((core) => {
    const seq = (seqByAgg.get(core.aggregateId) ?? 0) + 1
    seqByAgg.set(core.aggregateId, seq)
    const contentHash = contentHashOf(core)
    const ev: TrackEvent = { ...core, seq, prevHash, contentHash }
    prevHash = contentHash
    return ev
  })
}

function core(over: Partial<EventCore> = {}): EventCore {
  counter += 1
  return {
    id: `evt-${String(counter).padStart(4, '0')}`,
    type: 'item.created',
    aggregate: 'item',
    aggregateId: 'item-A',
    at: `2026-06-03T10:00:${String(counter).padStart(2, '0')}.000Z`,
    by: 'tester',
    payload: { k: counter },
    ...over,
  }
}

describe('validate — degenerate cases', () => {
  it('passes an empty stream', () => {
    expect(validate([])).toEqual({ ok: true, findings: [] })
  })

  it('passes a single event', () => {
    store.appendCommand([evt()])
    expect(validate(store.readAll())).toEqual({ ok: true, findings: [] })
  })

  it('passes a clean multi-aggregate stream', () => {
    store.appendCommand([evt()])
    store.appendCommand([evt({ aggregateId: 'item-B' })])
    store.appendCommand([evt()])
    expect(validate(store.readAll())).toEqual({ ok: true, findings: [] })
  })
})

describe('validate — content & frame tamper (A4)', () => {
  it('detects a tampered payload', () => {
    store.appendCommand([evt()])
    const tampered = store.readAll().map((e) => ({ ...e, payload: { hacked: true } }))
    expect(validate(tampered).findings).toContainEqual(
      expect.objectContaining({ kind: 'content-hash', index: 0 }),
    )
  })

  it('detects tamper of frame fields covered by contentHash (type / aggregateId / by)', () => {
    store.appendCommand([evt()])
    const events = store.readAll()
    for (const field of [{ type: 'chore' }, { aggregateId: 'item-Z' }, { by: 'mallory' }]) {
      const tampered = events.map((e) => ({ ...e, ...field }) as TrackEvent)
      expect(validate(tampered).findings.some((f) => f.kind === 'content-hash')).toBe(true)
    }
  })

  it('detects a reordered line (prevHash break)', () => {
    store.appendCommand([evt({ aggregateId: 'item-A' })])
    store.appendCommand([evt({ aggregateId: 'item-B' })])
    store.appendCommand([evt({ aggregateId: 'item-C' })])
    const [a, b, c] = store.readAll()
    expect(validate([a!, c!, b!]).findings.some((f) => f.kind === 'prev-hash')).toBe(true)
  })

  it('detects a per-aggregate seq break', () => {
    store.appendCommand([evt()])
    store.appendCommand([evt()])
    const broken = store.readAll().map((e, i) => (i === 1 ? { ...e, seq: 5 } : e))
    expect(validate(broken).findings).toContainEqual(
      expect.objectContaining({ kind: 'aggregate-seq', expected: 2, actual: 5 }),
    )
  })

  it('detects on-disk tampering of a __proto__ payload key (closes the A4 bypass)', () => {
    const payload = JSON.parse('{"note":"x","__proto__":{"flag":1}}') as Record<string, unknown>
    store.appendCommand([evt({ payload })])
    writeFileSync(eventsPath, readFileSync(eventsPath, 'utf8').replace('"flag":1', '"flag":999'))
    expect(validate(store.readAll()).findings.some((f) => f.kind === 'content-hash')).toBe(true)
  })

  it('persists each event as canonical (sorted-key) JSON — same serializer as the hash', () => {
    const [event] = store.appendCommand([evt()])
    const raw = readFileSync(eventsPath, 'utf8').trim()
    expect(raw).toBe(canonicalize(event!))
  })

  it('persists correctly even under Object.prototype.toJSON pollution', () => {
    const proto = Object.prototype as { toJSON?: unknown }
    proto.toJSON = () => ({ persisted: 'different' })
    try {
      store.appendCommand([evt()])
      expect(validate(store.readAll()).ok).toBe(true)
    } finally {
      delete proto.toJSON
    }
  })

  it('snapshots a live (Proxy) payload once, so it round-trips consistently', () => {
    let reads = 0
    const proxy = new Proxy({} as Record<string, unknown>, {
      ownKeys: () => ['x'],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, writable: true, value: 0 }),
      get: (_target, prop) => (prop === 'x' ? ++reads : undefined),
      getPrototypeOf: () => Object.prototype,
    })
    store.appendCommand([evt({ payload: proxy })])
    expect(validate(store.readAll()).ok).toBe(true)
  })

  it('detects an aggregateId reused under a different aggregate type', () => {
    const events = chain([
      core({ aggregateId: 'X', aggregate: 'item' }),
      core({ aggregateId: 'X', aggregate: 'blocker', type: 'blocker.opened' }),
    ])
    expect(validate(events).findings).toContainEqual(
      expect.objectContaining({ kind: 'aggregate-mismatch', expected: 'item', actual: 'blocker' }),
    )
  })
})

describe('validate — atomic batch (A5)', () => {
  it('accepts a complete batch', () => {
    store.appendCommand(
      [
        evt({ aggregate: 'decision', aggregateId: 'dec-1', type: 'decision.outcome' }),
        evt({ aggregate: 'item', aggregateId: 'item-X', type: 'realization.transition' }),
      ],
      { cmdId: 'cmd-1' },
    )
    expect(validate(store.readAll()).ok).toBe(true)
  })

  it('detects a dropped trailing member via cmd:{i,n}', () => {
    store.appendCommand(
      [
        evt({ aggregate: 'decision', aggregateId: 'dec-1', type: 'decision.outcome' }),
        evt({ aggregate: 'blocker', aggregateId: 'blk-1', type: 'blocker.resolved' }),
        evt({ aggregate: 'item', aggregateId: 'item-X', type: 'realization.transition' }),
      ],
      { cmdId: 'cmd-1' },
    )
    const partial = store.readAll().slice(0, 2)
    const result = validate(partial)
    expect(result.findings.some((f) => f.kind === 'prev-hash')).toBe(false)
    expect(result.findings.some((f) => f.kind === 'aggregate-seq')).toBe(false)
    expect(result.findings).toContainEqual(
      expect.objectContaining({ kind: 'partial-batch', cmdId: 'cmd-1', expected: 3 }),
    )
  })

  it('detects inconsistent cmd.n across members', () => {
    const events = chain([
      core({ aggregateId: 'a', cmdId: 'cmd-1', cmd: { i: 0, n: 3 } }),
      core({ aggregateId: 'b', cmdId: 'cmd-1', cmd: { i: 1, n: 2 } }),
    ])
    expect(validate(events).findings).toContainEqual(
      expect.objectContaining({ kind: 'partial-batch', cmdId: 'cmd-1' }),
    )
  })

  it('detects a duplicate batch index', () => {
    const events = chain([
      core({ aggregateId: 'a', cmdId: 'cmd-1', cmd: { i: 0, n: 2 } }),
      core({ aggregateId: 'b', cmdId: 'cmd-1', cmd: { i: 0, n: 2 } }),
    ])
    expect(validate(events).findings.some((f) => f.kind === 'partial-batch')).toBe(true)
  })

  it('detects cmd without cmdId and cmdId without cmd', () => {
    const orphanCmd = chain([core({ cmd: { i: 0, n: 1 } })])
    expect(validate(orphanCmd).findings).toContainEqual(
      expect.objectContaining({ kind: 'batch-frame', reason: expect.stringContaining('without cmdId') }),
    )
    const orphanCmdId = chain([core({ cmdId: 'cmd-9' })])
    expect(validate(orphanCmdId).findings).toContainEqual(
      expect.objectContaining({ kind: 'batch-frame', reason: expect.stringContaining('without cmd') }),
    )
  })
})

describe('validate — head anchor (suffix truncation)', () => {
  it('detects suffix truncation against the recorded head', () => {
    store.appendCommand([evt()])
    store.appendCommand([evt()])
    store.appendCommand([evt()])
    const head = readHead(eventsPath)
    const truncated = store.readAll().slice(0, -1)

    expect(validate(truncated).ok).toBe(true) // undetectable from the array alone
    expect(validate(truncated, head).findings).toContainEqual(
      expect.objectContaining({ kind: 'truncation', expected: 3, actual: 2 }),
    )
  })

  it('accepts a stream consistent with its head', () => {
    store.appendCommand([evt()])
    store.appendCommand([evt()])
    expect(validate(store.readAll(), readHead(eventsPath)).ok).toBe(true)
  })
})
