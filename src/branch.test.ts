import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acceptanceStatus } from './accept/status.js'
import { parseBranch } from './branch/parse.js'
import { EventStore } from './events/store.js'
import { Track } from './track.js'

// A realistic BRANCH_TEMPLATE fixture (mirrors sentropic/plan/NN-BRANCH_*.md structure).
const FIXTURE = `# Feature: BR-99 — Demo Feature

## Objective
Demonstrate the importer.

## Scope / Guardrails
- Limited to demo.

## Plan / Todo (lot-based)
- [x] **Lot 0 — Scaffold the thing**
  - [ ] make typecheck
- [ ] **Lot 1 — Core logic**
  - [x] UAT: web app loads
  - [ ] make test-api
- [ ] **Lot 2 — Polish**
  - [ ] UAT: edge cases reviewed
`

// Same branch, lots reordered (Lot 2 before Lot 1) — sourceKeys are slug-based, so re-import is a no-op.
const FIXTURE_REORDERED = `# Feature: BR-99 — Demo Feature

## Plan / Todo (lot-based)
- [x] **Lot 0 — Scaffold the thing**
- [ ] **Lot 2 — Polish**
  - [ ] UAT: edge cases reviewed
- [ ] **Lot 1 — Core logic**
  - [x] UAT: web app loads
`

let dir: string
let store: EventStore
let track: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-branch-'))
  store = new EventStore(join(dir, '.track', 'events.jsonl'))
  let n = 0
  track = new Track(store, {
    by: 'tester',
    now: () => '2026-06-03T10:00:00.000Z',
    newId: () => `id-${String(++n).padStart(4, '0')}`,
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseBranch', () => {
  it('parses feature/lots/UAT and ignores gate sub-checkboxes', () => {
    const p = parseBranch(FIXTURE)
    expect(p.branchSlug).toBe('br-99')
    expect(p.feature.title).toBe('BR-99 — Demo Feature')
    expect(p.lots.map((l) => l.lotSlug)).toEqual(['scaffold-the-thing', 'core-logic', 'polish'])
    expect(p.lots[0]!.done).toBe(true)
    expect(p.lots[1]!.done).toBe(false)
    // UAT extracted; gate checkbox "make ..." ignored
    expect(p.lots[0]!.uat).toHaveLength(0)
    expect(p.lots[1]!.uat.map((u) => u.statement)).toEqual(['UAT: web app loads'])
    expect(p.lots[1]!.uat[0]!.passed).toBe(true)
    expect(p.lots[2]!.uat[0]!.passed).toBe(false)
  })

  it('keeps the title for `**Lot N-2** UAT` and `Lot N-2 — UAT` (hyphen in N-2 is not the separator)', () => {
    const p = parseBranch(
      '# Feature: BR-1 — X\n## Plan / Todo\n- [ ] **Lot N-2** UAT\n- [ ] **Lot N-1 — Docs consolidation**\n',
    )
    expect(p.lots.map((l) => l.title)).toEqual(['UAT', 'Docs consolidation'])
    expect(p.lots.map((l) => l.lotSlug)).toEqual(['uat', 'docs-consolidation'])
  })

  it('does not drop a lot with a non-[ x] marker (e.g. [~] deferred → to-do)', () => {
    const p = parseBranch(
      '# Feature: BR-1 — X\n## Plan / Todo\n- [~] **Lot N-2 — UAT**\n- [x] **Lot 0 — Base**\n',
    )
    expect(p.lots.map((l) => l.lotSlug)).toEqual(['uat', 'base'])
    expect(p.lots[0]!.done).toBe(false)
    expect(p.lots[1]!.done).toBe(true)
  })

  it('derives branchSlug from a BR-id anywhere (not just the H1), avoiding "BRANCH"', () => {
    expect(parseBranch('# Branch Plan Stub: BR-27 marketplace\n## Plan\n').branchSlug).toBe('br-27')
    // "BRANCH" alone is not a BR-id; fall back to fileSlug
    expect(parseBranch('# Notes\nsee BRANCH.md\n', { fileSlug: 'my-file' }).branchSlug).toBe('my-file')
  })
})

describe('importBranch — A1', () => {
  it('derives a feature + one chore per lot, maps checkboxes and UAT', () => {
    const result = track.importBranch(FIXTURE, { locator: 'BRANCH.md', commit: 'c1' })
    expect(result.branchSlug).toBe('br-99')

    const s = track.state()
    expect([...s.items.values()].filter((i) => i.kind === 'feature')).toHaveLength(1)
    expect([...s.items.values()].filter((i) => i.kind === 'chore')).toHaveLength(3)

    const find = (sk: string) => [...s.items.values()].find((i) => i.sourceKey === sk)!
    expect(find('br-99').kind).toBe('feature')
    expect(find('br-99/scaffold-the-thing').realization).toBe('done') // [x]
    expect(find('br-99/core-logic').realization).toBe('to-do') // [ ]
    expect(find('br-99/scaffold-the-thing').parentId).toBe(find('br-99').id)
    expect(find('br-99/core-logic').links?.[0]).toEqual({ kind: 'branch.md', locator: 'BRANCH.md' })

    // UAT [x] -> manual pass run -> acceptance pass; UAT [ ] -> criterion with no run -> unknown
    expect(acceptanceStatus(s, find('br-99/core-logic').id, 'c1')).toBe('pass')
    expect(acceptanceStatus(s, find('br-99/polish').id, 'c1')).toBe('unknown')
  })

  it('leaves the BRANCH content unread-as-source-of-truth: re-import is idempotent (delta-only)', () => {
    track.importBranch(FIXTURE, { locator: 'BRANCH.md', commit: 'c1' })
    const afterFirst = store.readAll().length

    const second = track.importBranch(FIXTURE, { locator: 'BRANCH.md', commit: 'c1' })
    expect(second).toMatchObject({ created: 0, updated: 0 })
    expect(store.readAll().length).toBe(afterFirst) // no new events
  })

  it('records a manual pass run when a UAT goes [ ] -> [x] on re-import (delta)', () => {
    const unchecked = '# Feature: BR-50 — D\n## Plan / Todo\n- [ ] **Lot 1 — Core**\n  - [ ] UAT: works\n'
    track.importBranch(unchecked, { locator: 'BRANCH.md', commit: 'c1' })
    const lotId = [...track.state().items.values()].find((i) => i.sourceKey === 'br-50/core')!.id
    expect(acceptanceStatus(track.state(), lotId, 'c1')).toBe('unknown') // UAT [ ] → no run

    const checked = '# Feature: BR-50 — D\n## Plan / Todo\n- [ ] **Lot 1 — Core**\n  - [x] UAT: works\n'
    const result = track.importBranch(checked, { locator: 'BRANCH.md', commit: 'c1' })
    expect(result.updated).toBeGreaterThanOrEqual(1)
    expect(acceptanceStatus(track.state(), lotId, 'c1')).toBe('pass') // [x] → manual pass run
  })

  it('survives lot reordering (slug-based sourceKey): reordered re-import is a no-op', () => {
    track.importBranch(FIXTURE, { locator: 'BRANCH.md', commit: 'c1' })
    const afterFirst = store.readAll().length

    const reordered = track.importBranch(FIXTURE_REORDERED, { locator: 'BRANCH.md', commit: 'c1' })
    expect(reordered).toMatchObject({ created: 0, updated: 0 })
    expect(store.readAll().length).toBe(afterFirst)
  })
})
