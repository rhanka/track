// WP-codes A1 — the GATE: a report with NO code is BYTE-IDENTICAL to the pre-codes rendering.
//
// Proof in two layers (no pre-change snapshot needed):
//  (1) STRUCTURAL — for a no-code forest, every `computeWpTree` label equals the EXACT pre-codes positional
//      derivation (`WP<n>` roots in ULID order; `${parent}.${ordinal}` sub-WPs) AND no node carries a `code`
//      key. Since `report/format.ts` is UNTOUCHED by A1, an identical `WpNode` forest ⇒ identical bytes out.
//      assertDerived would FAIL the instant the no-code path diverged.
//  (2) GOLDEN — the rendered conductor + tree strings are pinned to a committed fixture (regression guard).
//      The fixture self-bootstraps on first run; layer (1) is the authoritative byte-identity argument.

import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from './events/store.js'
import type { Ulid } from './events/types.js'
import { computeWpTree, type WpNode } from './report/rollup.js'
import { formatWpConductor, formatWpTree } from './report/format.js'
import { Track } from './track.js'

let dir: string
let t: Track

const now = (): string => '2026-06-29T00:00:00.000Z'
const counter = (): (() => Ulid) => {
  let i = 0
  return () => `id-${String(++i).padStart(4, '0')}`
}
const cfg = { baselineCommit: 'c1', requireAccepted: false }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-golden-'))
  t = new Track(new EventStore(join(dir, '.track', 'events.jsonl')), { by: 'human:x', now, newId: counter() })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Build a representative NO-CODE forest: roots + sub-WP + spec-phase + leaves of every bucket. */
function buildNoCodeForest(): void {
  const wp = (title: string, parentId?: Ulid): Ulid =>
    t.createItem({ kind: 'chore', title, workspace: 'ws', role: 'workpackage', ...(parentId !== undefined ? { parentId } : {}) })
  const phase = (title: string, parentId: Ulid): Ulid =>
    t.createItem({ kind: 'chore', title, workspace: 'ws', role: 'spec-phase', parentId })
  const leaf = (title: string, parentId: Ulid): Ulid =>
    t.createItem({ kind: 'chore', title, workspace: 'ws', parentId })
  const done = (id: Ulid): void => {
    t.setRealization(id, 'in-progress')
    t.setRealization(id, 'done')
  }
  const drop = (id: Ulid): void => t.setRealization(id, 'cancelled')

  const r1 = wp('Alpha')
  done(leaf('a-done', r1))
  leaf('a-todo', r1)
  const sp = phase('Phase', r1) // spec-phase ⇒ a dotted sub-node (WP1.1)
  done(leaf('p-done', sp))
  const sub = wp('Sub', r1) // sub-WP ⇒ WP1.2
  leaf('s-todo', sub)
  drop(leaf('s-dropped', sub))

  const r2 = wp('Beta')
  done(leaf('b-done', r2))

  wp('Gamma') // empty roster root ⇒ 0/0 n/a
}

/** Assert every label is the EXACT pre-codes positional derivation and NO node carries a code. */
function assertDerived(nodes: readonly WpNode[], prefix: string): void {
  nodes.forEach((n, i) => {
    const expected = prefix === '' ? `WP${i + 1}` : `${prefix}.${i + 1}`
    expect(n.label).toBe(expected)
    expect('code' in n).toBe(false)
    assertDerived(n.children, expected)
  })
}

describe('WP-codes A1 — GATE: no-code report is byte-identical to the pre-codes rendering', () => {
  it('every label is the pre-codes positional derivation; no node carries a `code` key', () => {
    buildNoCodeForest()
    assertDerived(computeWpTree(t.state(), cfg), '')
  })

  it('the rendered conductor + tree strings match the committed golden fixture', () => {
    buildNoCodeForest()
    const treeNodes = computeWpTree(t.state(), cfg)
    const rendered =
      '=== formatWpConductor(text) ===\n' +
      formatWpConductor(treeNodes, 'text') +
      '\n=== formatWpTree(md) ===\n' +
      formatWpTree(treeNodes, 'md')

    const goldenPath = join(process.cwd(), 'src', '__fixtures__', 'wp-codes-nocode.golden.txt')
    if (!existsSync(goldenPath) || process.env['UPDATE_GOLDEN'] === '1') {
      mkdirSync(join(process.cwd(), 'src', '__fixtures__'), { recursive: true })
      writeFileSync(goldenPath, rendered)
    }
    expect(rendered).toBe(readFileSync(goldenPath, 'utf8'))
  })
})
