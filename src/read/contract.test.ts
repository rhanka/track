import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { Track } from '../track.js'
import { READ_CONTRACT_VERSION, StaleSidecarError, TrackReader } from './contract.js'

// Base BRANCH.md. The variants below isolate one dimension each.
const FIXTURE = `# Feature: BR-99 — Demo Feature

## Objective
Demonstrate the importer.

## Plan / Todo (lot-based)
- [x] **Lot 0 — Scaffold the thing**
- [ ] **Lot 1 — Core logic**
  - [x] UAT: web app loads
- [ ] **Lot 2 — Polish**
  - [ ] UAT: edge cases reviewed
`

// Same reconciled structure (lots/UAT/done/passed) — only PROSE differs. Must read FRESH.
const PROSE_EDIT = `# Feature: BR-99 — Demo Feature

## Objective
A completely rewritten, much longer objective paragraph that track never imports.

## Plan / Todo (lot-based)
- [x] **Lot 0 — Scaffold the thing**
- [ ] **Lot 1 — Core logic**
  - [x] UAT: web app loads
- [ ] **Lot 2 — Polish**
  - [ ] UAT: edge cases reviewed
`

// Same structure, lots REORDERED. Must read FRESH (signature is slug-sorted).
const REORDER = `# Feature: BR-99 — Demo Feature

## Plan / Todo (lot-based)
- [ ] **Lot 2 — Polish**
  - [ ] UAT: edge cases reviewed
- [x] **Lot 0 — Scaffold the thing**
- [ ] **Lot 1 — Core logic**
  - [x] UAT: web app loads
`

// RECONCILED change: Lot 1 now [x] (done). Must read STALE until re-imported.
const STRUCT_CHANGE = `# Feature: BR-99 — Demo Feature

## Plan / Todo (lot-based)
- [x] **Lot 0 — Scaffold the thing**
- [x] **Lot 1 — Core logic**
  - [x] UAT: web app loads
- [ ] **Lot 2 — Polish**
  - [ ] UAT: edge cases reviewed
`

const OTHER = `# Feature: BR-50 — Other

## Plan / Todo (lot-based)
- [ ] **Lot A — Alpha**
- [ ] **Lot B — Beta**
`

// Reconciled changes that MUST read stale (the false-FRESH danger if a projected field is missed).
const UAT_UNCHECKED = FIXTURE.replace('  - [x] UAT: web app loads', '  - [ ] UAT: web app loads')
const NEW_LOT = FIXTURE + '- [ ] **Lot 3 — Extra**\n'
// Same lots/UAT as FIXTURE but a DIFFERENT BR id — importing would create a new feature/lots, so it
// must NOT read fresh against the br-99 import (branchSlug is part of import identity).
const DIFF_BR = FIXTURE.replace('BR-99 — Demo Feature', 'BR-50 — Demo Feature')

const L = 'plan/99-BRANCH_demo.md'
const L2 = 'plan/50-BRANCH_other.md'
const OPTS = { baselineCommit: 'HEAD' }

let dir: string
let eventsPath: string
let track: Track
let reader: TrackReader

function freshTrack(): void {
  let n = 0
  track = new Track(new EventStore(eventsPath), {
    by: 'tester',
    now: () => '2026-06-03T10:00:00.000Z',
    newId: () => `id-${String(++n).padStart(4, '0')}`,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-read-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  freshTrack()
  reader = new TrackReader(eventsPath)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('read contract — version + curated surface (snapshot gate)', () => {
  it('exposes a stable semver and the documented read methods', () => {
    expect(READ_CONTRACT_VERSION).toBe('1.1.0')
    expect(reader.contractVersion).toBe(READ_CONTRACT_VERSION)
    const api = reader as unknown as Record<string, unknown>
    for (const m of ['report', 'query', 'validate', 'branchProvenance', 'freshness', 'requireFresh', 'externalDependencies']) {
      expect(typeof api[m]).toBe('function')
    }
  })

  it('pins the report-row shape so a breaking field change fails CI', () => {
    track.importBranch(FIXTURE, { locator: L })
    const row = reader.query({}, OPTS)[0]!
    expect(Object.keys(row).sort()).toEqual([
      'acceptance',
      'bucket',
      'id',
      'kind',
      'realization',
      'title',
      'workspace',
    ])
  })
})

describe('TrackReader — read parity with the command facade', () => {
  beforeEach(() => {
    track.importBranch(FIXTURE, { locator: L })
  })

  it('report() matches Track.report() across option flavours', () => {
    for (const opts of [OPTS, { ...OPTS, requireAccepted: true }, { ...OPTS, decisions: true }]) {
      expect(JSON.stringify(reader.report(opts))).toBe(JSON.stringify(track.report(opts)))
    }
  })

  it('query() matches Track.query()', () => {
    expect(JSON.stringify(reader.query({ kind: 'chore' }, OPTS))).toBe(
      JSON.stringify(track.query({ kind: 'chore' }, OPTS)),
    )
  })

  it('validate() is ok on an untampered log', () => {
    expect(reader.validate().ok).toBe(true)
  })
})

describe('TrackReader — branch provenance (latest VALID wins)', () => {
  it('returns the imported structureHash; latest delta wins; undefined otherwise', () => {
    track.importBranch(FIXTURE, { locator: L })
    const first = reader.branchProvenance(L)!
    expect(first.branchSlug).toBe('br-99')
    expect(first.sourceHash).toMatch(/^sha256:/)
    expect(first.structureHash).toMatch(/^sha256:/)

    track.importBranch(STRUCT_CHANGE, { locator: L }) // a real delta → new stamp
    const latest = reader.branchProvenance(L)!
    expect(latest.structureHash).not.toBe(first.structureHash)

    expect(reader.branchProvenance('plan/never.md')).toBeUndefined()
  })

  it('ignores a structurally-malformed branch.imported stamp (fails closed → absent)', () => {
    track.importBranch(FIXTURE, { locator: L })
    // Corrupt the structureHash to a non-sha256 value AND keep the log re-chained so integrity
    // passes — provenance validation alone must reject it.
    const lines = readFileSync(eventsPath, 'utf8').split('\n')
    const i = lines.findIndex((l) => l.includes('"branch.imported"'))
    lines[i] = lines[i]!.replace(/"structureHash":"sha256:[^"]+"/, '"structureHash":12345')
    writeFileSync(eventsPath, lines.join('\n'))
    expect(reader.branchProvenance(L)).toBeUndefined()
    expect(reader.freshness(FIXTURE, L)).toEqual({ status: 'absent' })
  })

  it('does NOT fall back to an older valid stamp when the LATEST is malformed (fail-closed)', () => {
    track.importBranch(FIXTURE, { locator: L }) // stamp 1 (valid)
    track.importBranch(STRUCT_CHANGE, { locator: L }) // stamp 2 (valid, latest)
    // Corrupt ONLY the latest branch.imported stamp's structureHash.
    const lines = readFileSync(eventsPath, 'utf8').split('\n')
    const i = lines.reduce((acc, l, idx) => (l.includes('"branch.imported"') ? idx : acc), -1)
    lines[i] = lines[i]!.replace(/"structureHash":"sha256:[^"]+"/, '"structureHash":12345')
    writeFileSync(eventsPath, lines.join('\n'))
    // Must NOT silently use stamp 1 — the authoritative latest is malformed → absent → fail closed.
    expect(reader.branchProvenance(L)).toBeUndefined()
    expect(() => reader.requireFresh(STRUCT_CHANGE, L)).toThrow(StaleSidecarError)
  })
})

describe('TrackReader — freshness (structural, not byte)', () => {
  beforeEach(() => {
    track.importBranch(FIXTURE, { locator: L })
  })

  it('is fresh on a byte-identical content', () => {
    expect(reader.freshness(FIXTURE, L)).toMatchObject({ status: 'fresh' })
  })

  it('is fresh on a PROSE-only edit with no re-import (no false-stale — review F1)', () => {
    expect(reader.freshness(PROSE_EDIT, L)).toMatchObject({ status: 'fresh' })
  })

  it('is fresh on a lot REORDER with no re-import', () => {
    expect(reader.freshness(REORDER, L)).toMatchObject({ status: 'fresh' })
  })

  it('is stale on a reconciled structural change (a lot toggled done)', () => {
    const f = reader.freshness(STRUCT_CHANGE, L)
    expect(f.status).toBe('stale')
    if (f.status === 'stale') expect(f.expected).not.toBe(f.actual)
  })

  it('goes stale → fresh once the structural change is re-imported', () => {
    expect(reader.freshness(STRUCT_CHANGE, L).status).toBe('stale')
    track.importBranch(STRUCT_CHANGE, { locator: L })
    expect(reader.freshness(STRUCT_CHANGE, L).status).toBe('fresh')
  })

  it('is per-locator: a second branch does not affect the first', () => {
    track.importBranch(OTHER, { locator: L2 })
    expect(reader.freshness(FIXTURE, L)).toMatchObject({ status: 'fresh' })
    expect(reader.freshness(OTHER, L2)).toMatchObject({ status: 'fresh' })
    expect(reader.freshness(FIXTURE, L2).status).toBe('stale') // FIXTURE vs OTHER's structure
  })

  it('is absent when the locator was never imported', () => {
    expect(reader.freshness(FIXTURE, 'plan/never.md')).toEqual({ status: 'absent' })
  })

  // Projection-gap guards: any field importBranch reconciles MUST flip freshness, else a real
  // drift reads false-FRESH (the dangerous direction).
  it('is stale when a UAT is unchecked (passed flips)', () => {
    expect(reader.freshness(UAT_UNCHECKED, L).status).toBe('stale')
  })

  it('is stale when a new lot appears', () => {
    expect(reader.freshness(NEW_LOT, L).status).toBe('stale')
  })

  it('is stale when the BR id changes though lots are identical (no false-fresh)', () => {
    expect(reader.freshness(DIFF_BR, L).status).toBe('stale')
  })
})

describe('TrackReader — fileSlug import identity (fresh log, no pre-import)', () => {
  it('does NOT read false-fresh for a headingless branch imported with a fileSlug', () => {
    const headless = '## Plan / Todo\n- [ ] **Lot 0 — Scaffold**\n'
    track.importBranch(headless, { locator: 'plan/headless.md', fileSlug: 'br-foo' })
    // Reader cannot know the fileSlug → cannot establish identity → fail closed (stale), not fresh.
    expect(reader.freshness(headless, 'plan/headless.md').status).toBe('stale')
  })

  it('stays fresh for a heading branch even when imported with a fileSlug (brId wins)', () => {
    track.importBranch(FIXTURE, { locator: 'plan/withfs.md', fileSlug: 'override' })
    expect(reader.freshness(FIXTURE, 'plan/withfs.md').status).toBe('fresh')
  })

  it('fails closed for a no-BR-id branch even when title slug equals the fileSlug (no loophole)', () => {
    const noBr = '# Foo\n\n## Plan / Todo\n- [ ] **Lot 0 — Scaffold**\n' // title "Foo" → slug "foo"
    track.importBranch(noBr, { locator: 'plan/foo.md', fileSlug: 'foo' }) // import branchSlug "foo"
    // Reader would derive slugify(title)="foo" == fileSlug → without the BR-id gate this reads fresh.
    expect(reader.freshness(noBr, 'plan/foo.md').status).toBe('stale')
  })
})

describe('TrackReader — requireFresh fail-closed guard', () => {
  it('passes when fresh and integrity intact (incl. prose/reorder edits)', () => {
    track.importBranch(FIXTURE, { locator: L })
    expect(() => reader.requireFresh(FIXTURE, L)).not.toThrow()
    expect(() => reader.requireFresh(PROSE_EDIT, L)).not.toThrow()
    expect(() => reader.requireFresh(REORDER, L)).not.toThrow()
  })

  it('throws when stale', () => {
    track.importBranch(FIXTURE, { locator: L })
    try {
      reader.requireFresh(STRUCT_CHANGE, L)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(StaleSidecarError)
      expect((e as StaleSidecarError).detail.freshness.status).toBe('stale')
    }
  })

  it('throws on an empty / never-imported log (absent)', () => {
    expect(reader.validate().ok).toBe(true) // empty log is integral...
    expect(() => reader.requireFresh(FIXTURE, L)).toThrow(StaleSidecarError) // ...but absent → fail closed
  })

  it('throws when integrity is broken at the branch.imported event itself, even if fresh', () => {
    track.importBranch(FIXTURE, { locator: L })
    const lines = readFileSync(eventsPath, 'utf8').split('\n')
    const i = lines.findIndex((l) => l.includes('"branch.imported"'))
    lines[i] = lines[i]!.replace('"branchSlug":"br-99"', '"branchSlug":"br-zz"')
    writeFileSync(eventsPath, lines.join('\n'))
    expect(reader.validate().ok).toBe(false)
    try {
      reader.requireFresh(FIXTURE, L)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(StaleSidecarError)
      expect((e as StaleSidecarError).detail.integrityOk).toBe(false)
    }
  })
})
