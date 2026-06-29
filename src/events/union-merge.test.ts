import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from './store.js'
import type { CommandEvent } from './types.js'
import { validate } from './validate.js'
import { fold } from '../state/fold.js'

// B0a — `.gitattributes merge=union` reconciles two branches that each appended DISJOINT events
// (different aggregates) to the single append-only `.track/events.jsonl`. The union driver keeps
// EVERY unique line from both parents, so the merged log is `P + A-suffix + B-suffix` (common
// prefix once, then both branches' new lines). These tests pin the DEFINED behaviour of that merged
// log: (1) every event survives — `readAll` enumerates all of them and `fold` fully recovers the
// state of all aggregates (the anti-loss property B0a buys); (2) `validate` is LOUD, not silently
// corrupt — the GLOBAL positional `prevHash` chain breaks at the A→B seam (exactly one `prev-hash`
// finding), because two independently-chained suffixes cannot both chain from the prefix tail once
// interleaved. The residual: the merged log is read/fold-recoverable but must be RE-SEALED (re-chained)
// before further `track` appends, since the store fail-closes on an invalid existing log.

let dir: string
let counter: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-union-'))
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

function nonEmptyLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0)
}

/** Path under a throwaway tree whose parent `.track` dir is created up-front. */
function logPath(label: string): string {
  const p = join(dir, label, '.track', 'events.jsonl')
  mkdirSync(dirname(p), { recursive: true })
  return p
}

describe('B0a — union-merge of disjoint appends (common-prefix model)', () => {
  it('preserves every event and fully recovers state; validate is loud (one seam break)', () => {
    // Common prefix P (aggregate item-P, 2 events).
    const pPath = logPath('P')
    const pStore = new EventStore(pPath)
    pStore.appendCommand([evt({ aggregateId: 'item-P', payload: { kind: 'feature', title: 'P1', workspace: 'w' } })])
    pStore.appendCommand([evt({ aggregateId: 'item-P', type: 'realization.transition', payload: { to: 'in-progress' } })])
    const prefix = nonEmptyLines(pPath)
    expect(prefix.length).toBe(2)

    // Branch A continues from P (disjoint aggregate item-A).
    const aPath = logPath('A')
    copyFileSync(pPath, aPath)
    const aStore = new EventStore(aPath)
    aStore.appendCommand([evt({ aggregateId: 'item-A', payload: { kind: 'feature', title: 'A1', workspace: 'w' } })])
    aStore.appendCommand([evt({ aggregateId: 'item-A', type: 'realization.transition', payload: { to: 'done' } })])
    const aFull = nonEmptyLines(aPath) // P + A
    expect(aFull.length).toBe(4)

    // Branch B continues from P (disjoint aggregate item-B).
    const bPath = logPath('B')
    copyFileSync(pPath, bPath)
    const bStore = new EventStore(bPath)
    bStore.appendCommand([evt({ aggregateId: 'item-B', payload: { kind: 'feature', title: 'B1', workspace: 'w' } })])
    bStore.appendCommand([evt({ aggregateId: 'item-B', type: 'realization.transition', payload: { to: 'done' } })])
    const bFull = nonEmptyLines(bPath) // P + B
    expect(bFull.length).toBe(4)

    // The union-merge result = P + A-suffix + B-suffix (prefix kept once, both new tails appended).
    const aSuffix = aFull.slice(prefix.length)
    const bSuffix = bFull.slice(prefix.length)
    const merged = [...prefix, ...aSuffix, ...bSuffix]
    const mPath = logPath('M')
    writeFileSync(mPath, merged.join('\n') + '\n', 'utf8')

    // (1) Anti-loss: every event survives, and fold fully recovers all three aggregates.
    const all = new EventStore(mPath).readAll()
    expect(all.length).toBe(6)
    const state = fold(all)
    expect(state.items.has('item-P')).toBe(true)
    expect(state.items.has('item-A')).toBe(true)
    expect(state.items.has('item-B')).toBe(true)
    expect(state.items.get('item-A')!.realization).toBe('done')
    expect(state.items.get('item-B')!.realization).toBe('done')

    // (2) validate is LOUD: exactly one `prev-hash` finding at the A→B seam (index = |P|+|A| = 4).
    const result = validate(all)
    expect(result.ok).toBe(false)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.kind).toBe('prev-hash')
    expect(result.findings[0]).toMatchObject({ kind: 'prev-hash', index: 4 })

    // Residual: the store fail-closes on the broken chain — further appends are refused until re-seal.
    expect(() =>
      new EventStore(mPath).appendCommand([evt({ aggregateId: 'item-C', payload: { kind: 'feature', title: 'C1', workspace: 'w' } })]),
    ).toThrow(/refusing to extend an invalid log/)
  })

  it('two no-common-ancestor logs concatenated: all present, one seam break', () => {
    // The simpler model the brief states verbatim: two independent disjoint logs, concatenated.
    const aPath = logPath('X')
    const aStore = new EventStore(aPath)
    aStore.appendCommand([evt({ aggregateId: 'item-X', payload: { kind: 'feature', title: 'X1', workspace: 'w' } })])
    aStore.appendCommand([evt({ aggregateId: 'item-X', type: 'realization.transition', payload: { to: 'done' } })])

    const bPath = logPath('Y')
    const bStore = new EventStore(bPath)
    bStore.appendCommand([evt({ aggregateId: 'item-Y', payload: { kind: 'feature', title: 'Y1', workspace: 'w' } })])
    bStore.appendCommand([evt({ aggregateId: 'item-Y', type: 'realization.transition', payload: { to: 'done' } })])

    const merged = [...nonEmptyLines(aPath), ...nonEmptyLines(bPath)]
    const mPath = logPath('Z')
    writeFileSync(mPath, merged.join('\n') + '\n', 'utf8')

    const all = new EventStore(mPath).readAll()
    expect(all.length).toBe(4)
    const result = validate(all)
    expect(result.ok).toBe(false)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.kind).toBe('prev-hash')
    // The seam is B's first event (index 2): it carries prevHash=null but now follows A's last.
    expect(result.findings[0]).toMatchObject({ kind: 'prev-hash', index: 2, actual: null })
  })
})
