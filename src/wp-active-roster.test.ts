// WP-codes A3 — exclude TERMINAL roots from the ACTIVE roster (DESIGN §A3).
//
// PRINCIPLE (Opus resolution, applied verbatim): a root's `WP<n>` ordinal is computed over ALL roots
// (A1 skip-claimed rule already in place) ⇒ every root has a STABLE positional number independent of the
// filter. A3 is a DISPLAY OPTION that, when ENABLED (`--active-roster`), OMITS terminal (DROPPED) roots
// from the rendered roster WITHOUT renumbering the survivors (a gap appears: WP1, WP3 when WP2 is hidden).
// Default OFF ⇒ render byte-identical to today. Stability comes from CODES (A1), never from a re-pack.
//
//  - "terminal" = a root container whose own realization is cancelled|rejected (buckets.ts:26 ⇒ DROPPED).
//  - a DONE root is NEVER terminal — a delivered WP stays a WP, always in the roster.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from './events/store.js'
import { computeWpTree, type WpNode } from './report/rollup.js'
import { reportText } from './read/commands.js'
import { TrackReader } from './read/contract.js'
import { Track } from './track.js'
import { runCli } from './cli/index.js'

let dir: string
let eventsPath: string
let t: Track

const now = (): string => '2026-06-29T00:00:00.000Z'
const cfg = { baselineCommit: 'c1', requireAccepted: false }
const base = { baselineCommit: 'c1' as const }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-a3-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  t = new Track(new EventStore(eventsPath), { by: 'human:x', now })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const wp = (title: string): string => t.createItem({ kind: 'chore', title, workspace: 'ws', role: 'workpackage' })
const leaf = (title: string, parentId: string): string => t.createItem({ kind: 'chore', title, workspace: 'ws', parentId })
const doneItem = (id: string): void => {
  t.setRealization(id, 'in-progress')
  t.setRealization(id, 'done')
}
const byTitle = (nodes: readonly WpNode[], title: string): WpNode => {
  const n = nodes.find((x) => x.title === title)
  if (n === undefined) throw new Error(`no root node titled ${title}`)
  return n
}

/**
 * Three roots in ULID/creation order: Alpha (active), Beta (CANCELLED ⇒ terminal), Gamma (DONE).
 * Labels are WP1/WP2/WP3 by stable position — Beta's WP2 ordinal is reserved whether or not it renders.
 */
function buildForest(): void {
  const alpha = wp('Alpha')
  leaf('alpha-open', alpha) // an open leaf ⇒ Alpha lands in À-FAIRE as WP1

  const beta = wp('Beta')
  leaf('beta-open', beta)
  t.setRealization(beta, 'cancelled') // terminal root (DROPPED)

  const gamma = wp('Gamma')
  doneItem(leaf('gamma-done', gamma))
  doneItem(gamma) // a DONE root — never terminal, always kept
}

// ---- 1. computeWpTree marks terminal roots; DONE is not terminal; ordinals stay stable -----------

describe('A3 — computeWpTree: terminal flag + stable positional ordinals', () => {
  it('flags a cancelled root `terminal:true`, leaves a DONE root un-flagged, keeps WP1/WP2/WP3', () => {
    buildForest()
    const tree = computeWpTree(t.state(), cfg)

    expect(byTitle(tree, 'Alpha').label).toBe('WP1')
    expect(byTitle(tree, 'Beta').label).toBe('WP2')
    expect(byTitle(tree, 'Gamma').label).toBe('WP3')

    // The cancelled root is terminal; the active and DONE roots are NOT.
    expect(byTitle(tree, 'Beta').terminal).toBe(true)
    expect('terminal' in byTitle(tree, 'Alpha')).toBe(false)
    expect('terminal' in byTitle(tree, 'Gamma')).toBe(false) // a delivered WP stays a WP
  })

  it('drops the `terminal` key entirely when no root is terminal (additive / drop-when-absent)', () => {
    const a = wp('Active')
    leaf('x', a)
    const tree = computeWpTree(t.state(), cfg)
    expect('terminal' in byTitle(tree, 'Active')).toBe(false)
  })
})

// ---- 2. GATE byte-identical: WITHOUT the flag the cancelled root still renders --------------------

describe('A3 — GATE: default (no --active-roster) is unchanged, terminal root still shown', () => {
  it('reportText default === explicit activeRoster:false, and both render the cancelled WP2', () => {
    buildForest()
    const reader = new TrackReader(eventsPath)
    const dflt = reportText(reader, { ...base, wpTree: true }, 'text')
    const off = reportText(reader, { ...base, wpTree: true, activeRoster: false }, 'text')

    expect(off).toBe(dflt) // the option defaults OFF ⇒ byte-identical
    expect(dflt).toContain('WP2 · Beta') // a cancelled root appears in the default roster (back-compat)
    expect(dflt).toContain('WP1 · Alpha')
    expect(dflt).toContain('WP3 · Gamma')
  })

  it('CLI `track report` (no flag) shows the cancelled root', () => {
    buildForest()
    const out: string[] = []
    const io = { cwd: dir, out: (s: string) => out.push(s), err: () => {} }
    expect(runCli(['report', '--commit', 'c1'], io)).toBe(0)
    expect(out.join('')).toContain('WP2 · Beta')
  })
})

// ---- 3. WITH the flag: terminal omitted, DONE kept, survivors keep their numbers (gap) ------------

describe('A3 — --active-roster: omit terminal roots WITHOUT renumbering survivors', () => {
  it('reportText activeRoster:true omits WP2·Beta, keeps WP1·Alpha and WP3·Gamma (gap, no re-pack)', () => {
    buildForest()
    const reader = new TrackReader(eventsPath)
    const text = reportText(reader, { ...base, wpTree: true, activeRoster: true }, 'text')

    expect(text).not.toContain('WP2 · Beta') // terminal root omitted
    expect(text).not.toContain('Beta') // its title is gone from the active roster entirely
    expect(text).toContain('WP1 · Alpha') // survivor keeps WP1
    expect(text).toContain('WP3 · Gamma') // DONE root kept AND still WP3 — NOT renumbered to WP2
  })

  it('CLI `track report --active-roster` omits the cancelled root but keeps the gap', () => {
    buildForest()
    const out: string[] = []
    const io = { cwd: dir, out: (s: string) => out.push(s), err: () => {} }
    expect(runCli(['report', '--active-roster', '--commit', 'c1'], io)).toBe(0)
    const text = out.join('')
    expect(text).not.toContain('Beta')
    expect(text).toContain('WP1 · Alpha')
    expect(text).toContain('WP3 · Gamma')
  })
})

// ---- 4. JSON contract: --active-roster does NOT prune; full forest + `terminal` flag --------------

describe('A3 — JSON keeps every node + a `terminal` flag (machine consumer filters itself)', () => {
  it('the JSON wpTree is identical with/without the flag and carries terminal:true on the cancelled root', () => {
    buildForest()
    const reader = new TrackReader(eventsPath)
    const on = reportText(reader, { ...base, wpTree: true, activeRoster: true }, 'json')
    const off = reportText(reader, { ...base, wpTree: true, activeRoster: false }, 'json')

    expect(on).toBe(off) // --active-roster is a HUMAN-render option; JSON stays the complete contract
    const wpTree = (JSON.parse(on) as { wpTree: WpNode[] }).wpTree
    expect(wpTree.map((n) => n.label)).toEqual(['WP1', 'WP2', 'WP3']) // all nodes present, no re-pack
    expect(byTitle(wpTree, 'Beta').terminal).toBe(true)
    expect('terminal' in byTitle(wpTree, 'Alpha')).toBe(false)
    expect('terminal' in byTitle(wpTree, 'Gamma')).toBe(false)
  })
})

// ---- 5. A1 interaction: a coded terminal root is omitted but its ordinal stays reserved -----------

describe('A3 × A1 — a coded terminal root omits under the flag, its ordinal stays reserved', () => {
  /**
   * Alpha carries the code `WP3` AND is cancelled (a coded terminal root). It reserves ordinal 3.
   * The uncoded survivors fill the gaps SKIPPING 3: Beta→WP1, Gamma→WP2, Delta→WP4.
   * Under --active-roster Alpha (its code `WP3`) is hidden, yet Delta stays WP4 — the gap persists.
   */
  function buildCodedForest(): void {
    const alpha = wp('Alpha')
    t.assignCode(alpha, 'WP3') // reserves ordinal 3 (A1 skip-claimed rule)
    leaf('alpha-open', alpha)
    t.setRealization(alpha, 'cancelled') // terminal, coded root

    leaf('beta-open', wp('Beta')) // uncoded ⇒ WP1
    leaf('gamma-open', wp('Gamma')) // uncoded ⇒ WP2
    leaf('delta-open', wp('Delta')) // uncoded ⇒ WP4 (ordinal 3 reserved by Alpha's code)
  }

  it('computeWpTree renders the coded root by its code and reserves its ordinal', () => {
    buildCodedForest()
    const tree = computeWpTree(t.state(), cfg)
    expect(byTitle(tree, 'Alpha').label).toBe('WP3')
    expect(byTitle(tree, 'Alpha').terminal).toBe(true)
    expect(byTitle(tree, 'Beta').label).toBe('WP1')
    expect(byTitle(tree, 'Gamma').label).toBe('WP2')
    expect(byTitle(tree, 'Delta').label).toBe('WP4') // ordinal 3 reserved even though it renders as code
  })

  it('--active-roster hides the coded terminal root but the reserved ordinal keeps the gap', () => {
    buildCodedForest()
    const reader = new TrackReader(eventsPath)
    const text = reportText(reader, { ...base, wpTree: true, activeRoster: true }, 'text')
    expect(text).not.toContain('Alpha') // coded terminal root omitted
    expect(text).toContain('WP1 · Beta')
    expect(text).toContain('WP2 · Gamma')
    expect(text).toContain('WP4 · Delta') // the WP3 gap persists (code reserved it; no re-pack to WP3)
  })
})
