// report-revamp — the conductor-grade `--wp` status (fait / à-faire(%·WP) / attendus).
// STRICT TDD: text render is escape-free, no doubled WP label, `--wp` drops the flat buckets, and
// the 3-table conductor view (FAIT / À-FAIRE / ATTENDUS) renders with correct membership.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from './events/store.js'
import { formatWpConductor, formatWpTree } from './report/format.js'
import { computeWpTree } from './report/rollup.js'
import { reportText } from './read/commands.js'
import { TrackReader } from './read/contract.js'
import { Track } from './track.js'
import { runCli } from './cli/index.js'

let dir: string
let eventsPath: string
let store: EventStore
let t: Track

const now = (): string => '2026-06-09T00:00:00.000Z'
const cfg = { baselineCommit: 'c1', requireAccepted: false }
const base = { baselineCommit: 'c1' as const }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-revamp-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  store = new EventStore(eventsPath)
  t = new Track(store, { by: 'human:x', now })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const done = (id: string): void => {
  t.setRealization(id, 'in-progress')
  t.setRealization(id, 'done')
}

// ---- 1. text render is escape-free (markdown escaping leaks ONLY to md) ------------------------

describe('report-revamp — text render has NO backslash escapes', () => {
  it('formatWpTree(text) renders titles clean (no \\( \\) \\- escapes)', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1 — Record Integrity', workspace: 'ws', role: 'workpackage' })
    t.createItem({ kind: 'chore', title: 'record-only (0.1.0)', workspace: 'ws', parentId: wp })
    const text = formatWpTree(computeWpTree(t.state(), cfg), 'text')
    expect(text).toContain('record-only (0.1.0)')
    expect(text).not.toContain('\\') // no backslash escapes anywhere in the text render
  })

  it('md render still escapes markdown metacharacters', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    t.createItem({ kind: 'chore', title: 'record-only (0.1.0)', workspace: 'ws', parentId: wp })
    const md = formatWpTree(computeWpTree(t.state(), cfg), 'md')
    expect(md).toContain('\\(0.1.0\\)') // md target still escapes
  })
})

// ---- 2. no doubled `WPn · WPn` label ----------------------------------------------------------

describe('report-revamp — no doubled WP label', () => {
  it('strips a redundant leading "WPn — " from the WP item title', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1 — Record Integrity', workspace: 'ws', role: 'workpackage' })
    t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws', parentId: wp })
    const text = formatWpConductor(computeWpTree(t.state(), cfg), 'text')
    expect(text).toContain('WP1 · Record Integrity')
    expect(text).not.toContain('WP1 · WP1')
    expect(text).not.toContain('WP1 — Record Integrity') // the raw stored prefix is gone
  })
})

// ---- 3. `--wp` omits the flat buckets; sections present --------------------------------------

describe('report-revamp — `--wp` structured view only (no flat bucket dump)', () => {
  function seed(): void {
    const wp1 = t.createItem({ kind: 'chore', title: 'WP1 — Done WP', workspace: 'ws', role: 'workpackage' })
    done(t.createItem({ kind: 'chore', title: 'd1', workspace: 'ws', parentId: wp1 }))

    const wp2 = t.createItem({ kind: 'chore', title: 'WP2 — Open WP', workspace: 'ws', role: 'workpackage' })
    t.createItem({ kind: 'chore', title: 'open-todo', workspace: 'ws', parentId: wp2 })
    const blocked = t.createItem({ kind: 'feature', title: 'awaited-leaf', workspace: 'ws', parentId: wp2 })
    // A pending decision keeps `blocked` AWAITED on a decision (createDecision opens a decision blocker).
    t.createDecision({
      decisionKind: 'commitment',
      title: 'gate awaited-leaf',
      workspace: 'ws',
      targets: [blocked],
      dossier: { context: '', options: [], qa: [] },
    })
  }

  it('omits the flat AWAITED/DROPPED/DONE/TO-DO headings in --wp mode', () => {
    seed()
    const text = reportText(new TrackReader(eventsPath), { ...base, wpTree: true }, 'text')
    expect(text).not.toMatch(/^AWAITED \(/m)
    expect(text).not.toMatch(/^DROPPED \(/m)
    expect(text).not.toMatch(/^DONE \(/m)
    expect(text).not.toMatch(/^TO-DO \(/m)
  })

  it('report WITHOUT --wp keeps the flat-bucket behavior (back-compat)', () => {
    seed()
    const text = reportText(new TrackReader(eventsPath), base, 'text')
    expect(text).toMatch(/^DONE \(/m)
    expect(text).toMatch(/^TO-DO \(/m)
  })

  it('FAIT / À-FAIRE / ATTENDUS sections are present with correct membership', () => {
    seed()
    const text = reportText(new TrackReader(eventsPath), { ...base, wpTree: true }, 'text')
    expect(text).toContain('FAIT')
    expect(text).toContain('À-FAIRE')
    expect(text).toContain('ATTENDUS')
    // FAIT carries the 100% WP + a global done/total pct
    expect(text).toMatch(/FAIT[\s\S]*WP1 · Done WP/)
    // global total = sum of all WP leaves (1 done of 3 active: d1 + open-todo + awaited-leaf) ⇒ 1/3, 33%
    expect(text).toMatch(/1\/3, 33%/)
  })

  it('an AWAITED leaf lands in ATTENDUS with a derived disposition', () => {
    seed()
    const text = reportText(new TrackReader(eventsPath), { ...base, wpTree: true }, 'text')
    const attendus = text.slice(text.indexOf('ATTENDUS'))
    expect(attendus).toContain('awaited-leaf')
    // AWAITED-on-a-decision ⇒ owner decision disposition
    expect(attendus).toContain('décision: owner')
  })

  it('an open OPEN (TO-DO) leaf appears under its WP in À-FAIRE (◦ marker)', () => {
    seed()
    const text = reportText(new TrackReader(eventsPath), { ...base, wpTree: true }, 'text')
    const afaire = text.slice(text.indexOf('À-FAIRE'), text.indexOf('ATTENDUS'))
    expect(afaire).toContain('◦ open-todo')
  })
})

// ---- 4. json path carries wpTree + global totals ----------------------------------------------

describe('report-revamp — json path emits wpTree + global totals', () => {
  it('--format json carries report.wpTree and a global done/total', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    done(t.createItem({ kind: 'chore', title: 'd', workspace: 'ws', parentId: wp }))
    t.createItem({ kind: 'chore', title: 'td', workspace: 'ws', parentId: wp })
    const json = reportText(new TrackReader(eventsPath), { ...base, wpTree: true }, 'json')
    const parsed = JSON.parse(json) as { wpTree?: unknown; wpTotals?: { done: number; active: number; pct: number | string } }
    expect(parsed.wpTree).toBeDefined()
    expect(parsed.wpTotals).toEqual({ done: 1, active: 2, dropped: 0, pct: 50 })
  })
})

// ---- 5. CLI end-to-end ------------------------------------------------------------------------

describe('report-revamp — CLI `track report --wp` end-to-end', () => {
  const cli = (...argv: string[]): { code: number; out: string; err: string } => {
    const out: string[] = []
    const err: string[] = []
    const io = { cwd: dir, out: (s: string) => out.push(s), err: (s: string) => err.push(s) }
    // sync commands only here → runCli returns a plain number (the async `focus` path is not exercised)
    return { code: runCli(argv, io) as number, out: out.join(''), err: err.join('') }
  }

  it('renders the conductor view, escape-free, with no flat buckets', () => {
    cli('init')
    const wp = cli('item', 'new', '--kind', 'chore', '--title', 'WP1 — Record Integrity', '--workspace', 'ws', '--role', 'workpackage').out.trim()
    cli('item', 'new', '--kind', 'chore', '--title', 'record-only (0.1.0)', '--workspace', 'ws', '--parent', wp)
    const r = cli('report', '--wp', '--commit', 'c1')
    expect(r.code).toBe(0)
    expect(r.out).toContain('WP1 · Record Integrity')
    expect(r.out).not.toContain('WP1 · WP1')
    expect(r.out).not.toContain('\\') // text render: no backslash escapes
    expect(r.out).not.toMatch(/^TO-DO \(/m) // flat buckets suppressed
  })
})
