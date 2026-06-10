import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { Track } from '../track.js'
import { TrackReader, READ_CONTRACT_VERSION, StaleSidecarError } from './contract.js'

let dir: string
let eventsPath: string
let store: EventStore
let t: Track

const now = (): string => '2026-06-09T00:00:00.000Z'
const base = { workspace: 'ws', baselineCommit: 'c1' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-scopeval-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  store = new EventStore(eventsPath)
  t = new Track(store, { by: 'human:x', now })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const reader = (): TrackReader => new TrackReader(eventsPath)
const active = (wp: string): string => {
  // give the WP/phase an active (to-do) leaf so it is "realization-active"
  const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws', parentId: wp })
  return leaf
}

describe('scope LOT(b) — scopeValidate basics', () => {
  it('bumps the read contract version (additive scopeValidate surface)', () => {
    // a minor bump beyond the 1.5.0 that shipped the verificationRuns/statusByLevel reads
    expect(READ_CONTRACT_VERSION.startsWith('1.')).toBe(true)
    expect(READ_CONTRACT_VERSION).not.toBe('1.5.0')
  })

  it('a declared, coherent active WP yields status pass with no findings', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    active(wp)
    t.declareScope(wp, { allowed: ['src/**'], forbidden: ['test/**'] })
    const out = reader().scopeValidate(base)
    expect(out.status).toBe('pass')
    expect(out.findings).toEqual([])
    const perWp = out.perWp.find((w) => w.wpId === wp)!
    expect(perWp.declared).toBe(true)
    expect(perWp.semanticStatus).toBe('ok')
  })

  it('returns status missing when there is no WP/spec-phase to validate', () => {
    t.createItem({ kind: 'chore', title: 'plain', workspace: 'ws' })
    const out = reader().scopeValidate(base)
    expect(out.status).toBe('missing')
    expect(out.perWp).toEqual([])
  })
})

describe('scope LOT(b) — semantic findings', () => {
  it('an undeclared active WP flags "scope-undeclared" and status fail', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    active(wp)
    const out = reader().scopeValidate(base)
    expect(out.status).toBe('fail')
    expect(out.findings.map((f) => f.code)).toContain('scope-undeclared')
    expect(out.findings.find((f) => f.code === 'scope-undeclared')!.wpId).toBe(wp)
    const perWp = out.perWp.find((w) => w.wpId === wp)!
    expect(perWp.declared).toBe(false)
    expect(perWp.semanticStatus).toBe('scope-undeclared')
  })

  it('does NOT flag an undeclared WP whose work is all done/dropped (not realization-active)', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP-done', workspace: 'ws', role: 'workpackage' })
    const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws', parentId: wp })
    t.setRealization(leaf, 'in-progress')
    t.setRealization(leaf, 'done')
    const out = reader().scopeValidate(base)
    // no active descendant leaf ⇒ not flagged for an undeclared scope
    expect(out.findings.map((f) => f.code)).not.toContain('scope-undeclared')
  })

  it('an allowed∩forbidden overlap flags "incoherent" (string-level set overlap, never path-matching)', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    active(wp)
    t.declareScope(wp, { allowed: ['src/a/**', 'src/b/**'], forbidden: ['src/b/**'] })
    const out = reader().scopeValidate(base)
    expect(out.status).toBe('fail')
    expect(out.findings.map((f) => f.code)).toContain('incoherent')
    const perWp = out.perWp.find((w) => w.wpId === wp)!
    expect(perWp.semanticStatus).toBe('incoherent')
  })

  it('scopes only WPs/phases in the requested workspace', () => {
    const wpA = t.createItem({ kind: 'chore', title: 'WPA', workspace: 'wsA', role: 'workpackage' })
    const leafA = t.createItem({ kind: 'chore', title: 'la', workspace: 'wsA', parentId: wpA })
    void leafA
    const wpB = t.createItem({ kind: 'chore', title: 'WPB', workspace: 'wsB', role: 'workpackage' })
    t.createItem({ kind: 'chore', title: 'lb', workspace: 'wsB', parentId: wpB })
    const out = new TrackReader(eventsPath).scopeValidate({ workspace: 'wsA', baselineCommit: 'c1' })
    expect(out.perWp.map((w) => w.wpId)).toEqual([wpA])
  })
})

describe('scope LOT(b) — VerificationRun evidence surfacing (read, never recompute)', () => {
  it('a clean VerificationRun surfaces as evidenceStatus "clean"', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    active(wp)
    t.declareScope(wp, { allowed: ['src/**'] })
    t.recordVerification({ runId: 'vr-1', runner: 'stp', commit: 'c1', verdict: 'clean', wpRef: wp }, { workspace: 'ws' })
    const out = reader().scopeValidate(base)
    const perWp = out.perWp.find((w) => w.wpId === wp)!
    expect(perWp.evidenceStatus).toBe('clean')
    expect(perWp.latestVerification?.runId).toBe('vr-1')
  })

  it('a violation VerificationRun surfaces as evidenceStatus "violation"', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    active(wp)
    t.declareScope(wp, { allowed: ['src/**'] })
    t.recordVerification({ runId: 'vr-2', runner: 'stp', commit: 'c1', verdict: 'violation', wpRef: wp, violations: ['src/x.ts'] }, { workspace: 'ws' })
    const out = reader().scopeValidate(base)
    const perWp = out.perWp.find((w) => w.wpId === wp)!
    expect(perWp.evidenceStatus).toBe('violation')
    expect(perWp.latestVerification?.violations).toEqual(['src/x.ts'])
  })

  it('surfaces the LATEST run per WP (the read never recomputes)', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    active(wp)
    t.declareScope(wp, { allowed: ['src/**'] })
    t.recordVerification({ runId: 'vr-a', runner: 'stp', commit: 'c1', verdict: 'violation', wpRef: wp }, { workspace: 'ws' })
    const t2 = new Track(store, { by: 'human:x', now: () => '2026-06-09T01:00:00.000Z' })
    t2.recordVerification({ runId: 'vr-b', runner: 'stp', commit: 'c1', verdict: 'clean', wpRef: wp }, { workspace: 'ws' })
    const out = reader().scopeValidate(base)
    const perWp = out.perWp.find((w) => w.wpId === wp)!
    expect(perWp.latestVerification?.runId).toBe('vr-b')
    expect(perWp.evidenceStatus).toBe('clean')
  })
})

describe('scope LOT(b) — fail-closed staleness (requireFresh reuse)', () => {
  // A BRANCH.md whose live content no longer matches the imported structure ⇒ requireFresh throws
  // StaleSidecarError ⇒ scopeValidate returns status 'stale' with NO partial verdict.
  const BRANCH_V1 = `# Feature: BR-01 — feat\n\n## Plan / Todo (lot-based)\n- [ ] **Lot 0 — do a thing**\n`
  const BRANCH_V2 = `# Feature: BR-01 — feat\n\n## Plan / Todo (lot-based)\n- [x] **Lot 0 — do a thing**\n`

  it('a stale sidecar (altered content) ⇒ status "stale", NO partial perWp verdict', () => {
    const branchPath = join(dir, 'BRANCH.md')
    writeFileSync(branchPath, BRANCH_V1)
    t.importBranch(BRANCH_V1, { locator: 'BRANCH.md' })
    // declare a WP so there WOULD be a verdict if not for the stale gate
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    active(wp)
    const out = reader().scopeValidate({ ...base, content: BRANCH_V2, locator: 'BRANCH.md' })
    expect(out.status).toBe('stale')
    expect(out.perWp).toEqual([]) // no partial verdict
    expect(out.findings).toEqual([]) // fail-closed: nothing semantic surfaced
  })

  it('a fresh sidecar passes the gate and validates normally', () => {
    writeFileSync(join(dir, 'BRANCH.md'), BRANCH_V1)
    t.importBranch(BRANCH_V1, { locator: 'BRANCH.md' })
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    active(wp)
    t.declareScope(wp, { allowed: ['src/**'] })
    const out = reader().scopeValidate({ ...base, content: BRANCH_V1, locator: 'BRANCH.md' })
    expect(out.status).toBe('pass')
  })

  it('surfaces the StaleSidecarError detail when a not-imported locator is given', () => {
    // content/locator with no matching branch.imported ⇒ freshness 'absent' ⇒ requireFresh throws ⇒ stale
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    active(wp)
    const out = reader().scopeValidate({ ...base, content: '# Feature: BR-99 — nope\n', locator: 'NOPE.md' })
    expect(out.status).toBe('stale')
  })
})

describe('scope LOT(b) — PURE read: no append, never ingests', () => {
  it('scopeValidate performs NO append (event count unchanged)', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    active(wp)
    const before = store.readAll().length
    reader().scopeValidate(base)
    reader().scopeValidate({ ...base, content: 'x', locator: 'nope' }) // even the stale path appends nothing
    expect(store.readAll().length).toBe(before)
  })
})

describe('scope LOT(b) — optional delivered-out-of-scope inference (opt-in, read-only)', () => {
  it('OFF by default: a done WP with a violation run is NOT flagged delivered-out-of-scope', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws', parentId: wp })
    t.declareScope(wp, { allowed: ['src/**'] })
    t.setRealization(leaf, 'in-progress')
    t.setRealization(leaf, 'done')
    t.recordVerification({ runId: 'vr-1', runner: 'stp', commit: 'c1', verdict: 'violation', wpRef: wp }, { workspace: 'ws' })
    const out = reader().scopeValidate(base)
    expect(out.findings.map((f) => f.code)).not.toContain('delivered-out-of-scope')
  })

  it('ON (opt-in): a done WP whose latest run is a violation flags delivered-out-of-scope (a read flag)', () => {
    const wp = t.createItem({ kind: 'chore', title: 'WP1', workspace: 'ws', role: 'workpackage' })
    const leaf = t.createItem({ kind: 'chore', title: 'leaf', workspace: 'ws', parentId: wp })
    t.declareScope(wp, { allowed: ['src/**'] })
    t.setRealization(leaf, 'in-progress')
    t.setRealization(leaf, 'done')
    t.recordVerification({ runId: 'vr-1', runner: 'stp', commit: 'c1', verdict: 'violation', wpRef: wp }, { workspace: 'ws' })
    const out = reader().scopeValidate({ ...base, inferDeliveredOutOfScope: true })
    expect(out.findings.map((f) => f.code)).toContain('delivered-out-of-scope')
    // no append — purely a read flag
    expect(store.readAll().filter((e) => e.type === 'scope.declared' || e.type === 'scope.verification-recorded').length).toBe(2)
  })
})
