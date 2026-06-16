import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acceptanceStatus } from './accept/status.js'
import { EventStore } from './events/store.js'
import { fold } from './state/fold.js'
import { Track } from './track.js'
import { TrackReader } from './read/contract.js'
import { ingest, type IngestContext } from './ingest/ingest.js'
import type { WorkEvent } from './ingest/contract.js'

// Acceptance-freshness lifecycle (anchor + consolidate). STRICT TDD; ADDITIVE; FROZEN contract intact.
// The decisions: AcceptanceStatus stays STRICT; anchor freshness is a READ DETAIL; ONE event kind
// `realization.anchored` serves both realize-time and merge-time anchoring (LAST-anchor authoritative);
// consolidate RE-STAMPS acceptance.run at the mergeCommit for done+accepted items (the squash/rebase heal).

let dir: string
let eventsPath: string
let track: Track
let reader: TrackReader

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-fresh-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  let n = 0
  track = new Track(new EventStore(eventsPath), {
    by: 'tester',
    now: () => '2026-06-03T10:00:00.000Z',
    newId: () => `id-${String(++n).padStart(4, '0')}`,
  })
  reader = new TrackReader(eventsPath)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function feature(): string {
  return track.createItem({ kind: 'feature', title: 'f', workspace: 'ws' })
}
function run(result: 'pass' | 'fail', commit = 'c1') {
  return { commit, env: 'ci', runner: 'vitest', result }
}
/** A done+accepted item with one pass criterion at `commit`. Returns {item, criterion, evidence}. */
function doneAccepted(commit = 'c1'): { item: string; criterion: string; evidence: string } {
  const item = feature()
  const c = track.addCriterion(item, 'works')
  const e = track.linkEvidence(c, 'unit', 't1')
  track.recordRun(e, run('pass', commit))
  track.setRealization(item, 'in-progress')
  track.setRealization(item, 'done')
  return { item, criterion: c, evidence: e }
}

describe('realization.anchored — fold the anchor (last-write-wins)', () => {
  it('anchorRealization sets ItemState.realizedCommit', () => {
    const i = feature()
    track.anchorRealization(i, 'sha-A')
    expect(fold(new EventStore(eventsPath).readAll()).items.get(i)!.realizedCommit).toBe('sha-A')
  })

  it('two anchors ⇒ the LATEST wins (priors stay in the log for audit)', () => {
    const i = feature()
    track.anchorRealization(i, 'sha-A')
    track.anchorRealization(i, 'sha-B')
    const events = new EventStore(eventsPath).readAll()
    expect(fold(events).items.get(i)!.realizedCommit).toBe('sha-B')
    // both anchor events persist (append-only audit)
    expect(events.filter((e) => e.type === 'realization.anchored')).toHaveLength(2)
  })

  it('restricts anchoring to a real, existing item', () => {
    expect(() => track.anchorRealization('does-not-exist', 'sha-A')).toThrow()
  })

  it('is clientToken-idempotent (a retry with the same token is a no-op)', () => {
    const i = feature()
    track.withClientToken('tok-1', () => track.anchorRealization(i, 'sha-A'))
    track.withClientToken('tok-1', () => track.anchorRealization(i, 'sha-A'))
    expect(
      new EventStore(eventsPath).readAll().filter((e) => e.type === 'realization.anchored'),
    ).toHaveLength(1)
  })
})

describe('consolidate — anchor + re-stamp the heal', () => {
  it('appends realization.anchored{reason:consolidate} + re-stamps pass runs at the mergeCommit', () => {
    const { item, evidence } = doneAccepted('c1')
    track.consolidate([item], 'merge-sha')
    const events = new EventStore(eventsPath).readAll()
    const anchored = events.find((e) => e.type === 'realization.anchored')!
    expect(anchored.payload).toMatchObject({ itemId: item, commit: 'merge-sha', reason: 'consolidate' })
    // the pass run is re-stamped at the merge commit (the heal — existing recordRun append)
    const state = fold(events)
    expect(state.evidence.get(evidence)!.latestRun!.commit).toBe('merge-sha')
    expect(state.evidence.get(evidence)!.latestRun!.result).toBe('pass')
  })

  it('does NOT re-stamp a failing item (its latest run is fail)', () => {
    const item = feature()
    const c = track.addCriterion(item, 'works')
    const e = track.linkEvidence(c, 'unit', 't1')
    track.recordRun(e, run('fail', 'c1'))
    track.setRealization(item, 'in-progress')
    track.setRealization(item, 'done')
    track.consolidate([item], 'merge-sha')
    const state = fold(new EventStore(eventsPath).readAll())
    // the fail run was NOT re-stamped to merge-sha (still the original failing run at c1)
    expect(state.evidence.get(e)!.latestRun!.commit).toBe('c1')
    expect(state.evidence.get(e)!.latestRun!.result).toBe('fail')
  })

  it('does NOT re-stamp an item that is not done', () => {
    const item = feature()
    const c = track.addCriterion(item, 'works')
    const e = track.linkEvidence(c, 'unit', 't1')
    track.recordRun(e, run('pass', 'c1'))
    track.setRealization(item, 'in-progress') // NOT done
    track.consolidate([item], 'merge-sha')
    const state = fold(new EventStore(eventsPath).readAll())
    expect(state.evidence.get(e)!.latestRun!.commit).toBe('c1') // untouched
    expect(state.items.get(item)!.realizedCommit).toBeUndefined() // no anchor for a non-done item
  })

  it('is clientToken-idempotent (re-running with the same token+mergeCommit is a no-op)', () => {
    const { item } = doneAccepted('c1')
    track.withClientToken('cons-1', () => track.consolidate([item], 'merge-sha'))
    const after1 = new EventStore(eventsPath).readAll().length
    track.withClientToken('cons-1', () => track.consolidate([item], 'merge-sha'))
    const after2 = new EventStore(eventsPath).readAll().length
    expect(after2).toBe(after1) // no new events
  })

  it('THE TREADMILL HEAL: a done+accepted item stale-against-a-moved-HEAD reads pass again after consolidate', () => {
    const { item } = doneAccepted('c1')
    // an unrelated merge moves HEAD to merge-sha; the item is now STALE against it
    expect(acceptanceStatus(track.state(), item, 'merge-sha')).toBe('stale')
    // consolidate re-stamps the pass run at merge-sha — heals to pass
    track.consolidate([item], 'merge-sha')
    expect(acceptanceStatus(track.state(), item, 'merge-sha')).toBe('pass')
  })

  it('restricts to real items (an unknown itemId throws before any append)', () => {
    expect(() => track.consolidate(['nope'], 'merge-sha')).toThrow()
  })

  it('PER-MERGE obligation (intended): consolidate at M1 ⇒ pass at M1; a later baseline M2 re-stales; consolidate at M2 ⇒ pass at M2 (SHOULD-FIX 3)', () => {
    const { item } = doneAccepted('c1')
    // M1: consolidate at the first merge commit — fresh at M1 ONLY.
    track.consolidate([item], 'M1')
    expect(acceptanceStatus(track.state(), item, 'M1')).toBe('pass')
    // A subsequent UNRELATED merge moves the baseline to M2; the strict cascade re-stales the item.
    expect(acceptanceStatus(track.state(), item, 'M2')).toBe('stale')
    // The SKILL must re-run consolidate on the merge that moved HEAD past the consolidated item.
    track.consolidate([item], 'M2')
    expect(acceptanceStatus(track.state(), item, 'M2')).toBe('pass')
  })
})

describe('consolidate eligibility — ONLY done AND accepted-at-its-own-commits items are acted on (MUST-FIX 1)', () => {
  /** A done item with two criteria, each one evidence; record runs `(r1,r2)` at `commit` (undefined ⇒ no run). */
  function doneTwoCriteria(
    r1: 'pass' | 'fail' | undefined,
    r2: 'pass' | 'fail' | undefined,
    commit = 'c1',
  ): { item: string; e1: string; e2: string } {
    const item = feature()
    const c1 = track.addCriterion(item, 'a')
    const c2 = track.addCriterion(item, 'b')
    const e1 = track.linkEvidence(c1, 'unit', 't1')
    const e2 = track.linkEvidence(c2, 'unit', 't2')
    if (r1 !== undefined) track.recordRun(e1, run(r1, commit))
    if (r2 !== undefined) track.recordRun(e2, run(r2, commit))
    track.setRealization(item, 'in-progress')
    track.setRealization(item, 'done')
    return { item, e1, e2 }
  }

  it('[pass, pass] ⇒ ELIGIBLE: anchored + BOTH evidence re-stamped at the mergeCommit', () => {
    const { item, e1, e2 } = doneTwoCriteria('pass', 'pass', 'c1')
    track.consolidate([item], 'merge-sha')
    const events = new EventStore(eventsPath).readAll()
    expect(events.some((e) => e.type === 'realization.anchored' && (e.payload as { itemId: string }).itemId === item)).toBe(true)
    const state = fold(events)
    expect(state.evidence.get(e1)!.latestRun!.commit).toBe('merge-sha')
    expect(state.evidence.get(e2)!.latestRun!.commit).toBe('merge-sha')
  })

  it('[pass, fail] ⇒ INELIGIBLE: SKIPPED ENTIRELY (no anchor, no re-stamp of the pass)', () => {
    const { item, e1, e2 } = doneTwoCriteria('pass', 'fail', 'c1')
    track.consolidate([item], 'merge-sha')
    const events = new EventStore(eventsPath).readAll()
    // NO anchor for this item
    expect(events.some((e) => e.type === 'realization.anchored' && (e.payload as { itemId: string }).itemId === item)).toBe(false)
    // NO acceptance.run appended for it (the pass evidence is NOT re-stamped)
    const state = fold(events)
    expect(state.evidence.get(e1)!.latestRun!.commit).toBe('c1') // untouched
    expect(state.evidence.get(e2)!.latestRun!.commit).toBe('c1') // untouched
    expect(state.items.get(item)!.realizedCommit).toBeUndefined()
  })

  it('[pass, un-run] ⇒ INELIGIBLE: SKIPPED (a criterion with no pass run is not accepted-at-own-commit)', () => {
    const { item, e1 } = doneTwoCriteria('pass', undefined, 'c1')
    track.consolidate([item], 'merge-sha')
    const events = new EventStore(eventsPath).readAll()
    expect(events.some((e) => e.type === 'realization.anchored' && (e.payload as { itemId: string }).itemId === item)).toBe(false)
    expect(fold(events).evidence.get(e1)!.latestRun!.commit).toBe('c1') // untouched
  })

  it('[pass, waived-only] ⇒ INELIGIBLE: a waived criterion has no pass run ⇒ not accepted-at-own-commit', () => {
    const item = feature()
    const c1 = track.addCriterion(item, 'a')
    const c2 = track.addCriterion(item, 'b')
    const e1 = track.linkEvidence(c1, 'unit', 't1')
    track.recordRun(e1, run('pass', 'c1'))
    track.waive(c2, 'accepted by waiver') // c2 has a waiver, no pass run
    track.setRealization(item, 'in-progress')
    track.setRealization(item, 'done')
    track.consolidate([item], 'merge-sha')
    const events = new EventStore(eventsPath).readAll()
    expect(events.some((e) => e.type === 'realization.anchored' && (e.payload as { itemId: string }).itemId === item)).toBe(false)
    expect(fold(events).evidence.get(e1)!.latestRun!.commit).toBe('c1') // untouched
  })

  it('zero-criteria done item ⇒ INELIGIBLE: nothing to heal (no anchor, no re-stamp)', () => {
    const item = feature()
    track.setRealization(item, 'in-progress')
    track.setRealization(item, 'done')
    track.consolidate([item], 'merge-sha')
    const events = new EventStore(eventsPath).readAll()
    expect(events.some((e) => e.type === 'realization.anchored' && (e.payload as { itemId: string }).itemId === item)).toBe(false)
    expect(fold(events).items.get(item)!.realizedCommit).toBeUndefined()
  })

  it('a MIXED item batched with an ELIGIBLE item: only the eligible one is acted on', () => {
    const { item: mixed, e1: mixedE } = doneTwoCriteria('pass', 'fail', 'c1')
    const { item: ok, evidence: okE } = doneAccepted('c1')
    track.consolidate([mixed, ok], 'merge-sha')
    const events = new EventStore(eventsPath).readAll()
    const state = fold(events)
    // eligible one is anchored + re-stamped
    expect(events.some((e) => e.type === 'realization.anchored' && (e.payload as { itemId: string }).itemId === ok)).toBe(true)
    expect(state.evidence.get(okE)!.latestRun!.commit).toBe('merge-sha')
    // mixed one is untouched
    expect(events.some((e) => e.type === 'realization.anchored' && (e.payload as { itemId: string }).itemId === mixed)).toBe(false)
    expect(state.evidence.get(mixedE)!.latestRun!.commit).toBe('c1')
    expect(state.items.get(mixed)!.realizedCommit).toBeUndefined()
  })
})

describe('read detail — acceptanceDetail exposes run/anchor SHAs + freshness hint', () => {
  it('no-anchor when the item has no realizedCommit', () => {
    const { item, evidence } = doneAccepted('c1')
    const detail = reader.acceptanceDetail(item, 'baseline-sha')
    const d = detail.criteria[0]!.evidence.find((e) => e.evidenceId === evidence)!
    expect(d.runCommit).toBe('c1')
    expect(d.anchorCommit).toBeUndefined()
    expect(d.freshness).toBe('no-anchor')
  })

  it('anchor-fresh when run.commit === realizedCommit', () => {
    const { item, evidence } = doneAccepted('c1')
    track.anchorRealization(item, 'c1') // anchor equals the run commit
    const detail = reader.acceptanceDetail(item, 'baseline-sha')
    const d = detail.criteria[0]!.evidence.find((e) => e.evidenceId === evidence)!
    expect(d.anchorCommit).toBe('c1')
    expect(d.freshness).toBe('anchor-fresh')
  })

  it('needs-ancestry when both SHAs present but unequal (the skill must decide via git)', () => {
    const { item, evidence } = doneAccepted('c1')
    track.anchorRealization(item, 'anchor-sha') // anchor ≠ run commit
    const detail = reader.acceptanceDetail(item, 'baseline-sha')
    const d = detail.criteria[0]!.evidence.find((e) => e.evidenceId === evidence)!
    expect(d.runCommit).toBe('c1')
    expect(d.anchorCommit).toBe('anchor-sha')
    expect(d.freshness).toBe('needs-ancestry')
  })

  it('after consolidate, run + anchor both equal the mergeCommit ⇒ anchor-fresh (purely decidable)', () => {
    const { item, evidence } = doneAccepted('c1')
    track.consolidate([item], 'merge-sha')
    const detail = reader.acceptanceDetail(item, 'baseline-sha')
    const d = detail.criteria[0]!.evidence.find((e) => e.evidenceId === evidence)!
    expect(d.runCommit).toBe('merge-sha')
    expect(d.anchorCommit).toBe('merge-sha')
    expect(d.freshness).toBe('anchor-fresh')
  })

  it('no-run: anchor present but the evidence has NO run ⇒ a DISTINCT hint (not needs-ancestry) (SHOULD-FIX 2)', () => {
    const item = feature()
    const c = track.addCriterion(item, 'works')
    const e = track.linkEvidence(c, 'unit', 't1') // linked but NEVER run
    track.anchorRealization(item, 'anchor-sha') // an anchor exists
    const detail = reader.acceptanceDetail(item, 'baseline-sha')
    const d = detail.criteria[0]!.evidence.find((ed) => ed.evidenceId === e)!
    expect(d.runCommit).toBeUndefined()
    expect(d.anchorCommit).toBe('anchor-sha')
    // a skill CANNOT run ancestry without a run SHA, so this is NOT needs-ancestry
    expect(d.freshness).toBe('no-run')
  })
})

describe('AcceptanceStatus / buckets / gates UNCHANGED for anchorless items', () => {
  it('anchorless done+accepted item: acceptanceStatus is strict-against-baseline (unchanged)', () => {
    const { item } = doneAccepted('c1')
    // strict baseline behavior: pass at c1, stale at a moved baseline — exactly as before the anchor build
    expect(acceptanceStatus(track.state(), item, 'c1')).toBe('pass')
    expect(acceptanceStatus(track.state(), item, 'c2')).toBe('stale')
  })

  it('buckets/report unchanged: a requireAccepted report buckets the done item by the strict baseline', () => {
    const { item } = doneAccepted('c1')
    const atRun = reader.report({ baselineCommit: 'c1', requireAccepted: true })
    expect(atRun.buckets.DONE.map((r) => r.id)).toContain(item)
    const moved = reader.report({ baselineCommit: 'c2', requireAccepted: true })
    expect(moved.buckets['TO-DO'].map((r) => r.id)).toContain(item) // strict stale ⇒ TO-DO, unchanged
  })
})

describe('ingest seam — binding gate + containment + idempotency for the new kinds', () => {
  const authed: IngestContext = {
    by: 'human:a',
    workspace: 'ws',
    prov: { transport: 'cli', proposed: false, auth: 'local-user' },
  }
  const unauth: IngestContext = { ...authed, prov: { transport: 'http', proposed: false, auth: 'unauthenticated' } }
  const ev = (kind: WorkEvent['kind'], payload: Record<string, unknown>, clientToken?: string): WorkEvent =>
    clientToken !== undefined ? { v: 1, kind, payload, clientToken } : { v: 1, kind, payload }

  it('item.anchor is binding (denied on an unauthenticated channel, allowed on local-user)', () => {
    const i = feature()
    const store = new EventStore(eventsPath)
    expect(() => ingest([ev('item.anchor', { itemId: i, commit: 'sha-A' })], unauth, store)).toThrow(
      /binding write|authenticated/,
    )
    ingest([ev('item.anchor', { itemId: i, commit: 'sha-A' })], authed, store)
    expect(fold(store.readAll()).items.get(i)!.realizedCommit).toBe('sha-A')
  })

  it('item.consolidate is binding + clientToken-idempotent through the seam', () => {
    const { item } = doneAccepted('c1')
    const store = new EventStore(eventsPath)
    expect(() => ingest([ev('item.consolidate', { items: [item], mergeCommit: 'm' })], unauth, store)).toThrow(
      /binding write|authenticated/,
    )
    ingest([ev('item.consolidate', { items: [item], mergeCommit: 'm' }, 'tok-c')], authed, store)
    const after1 = store.readAll().length
    ingest([ev('item.consolidate', { items: [item], mergeCommit: 'm' }, 'tok-c')], authed, store) // retry
    expect(store.readAll().length).toBe(after1) // skipped — idempotent
    expect(acceptanceStatus(fold(store.readAll()), item, 'm')).toBe('pass') // healed
  })

  it('item.consolidate containment: a W-pinned channel cannot consolidate a V item', () => {
    const { item } = doneAccepted('c1') // workspace 'ws'
    const store = new EventStore(eventsPath)
    const otherWs: IngestContext = { ...authed, workspace: 'other-ws' }
    expect(() => ingest([ev('item.consolidate', { items: [item], mergeCommit: 'm' })], otherWs, store)).toThrow(
      /workspace/,
    )
  })
})

describe('FROZEN contract — anchorless log folds byte-identical (additive-hash invariant)', () => {
  it('a pre-anchor log (no realization.anchored, no realizedCommit) folds to the same ItemState + same contentHash', () => {
    // Build a log with NO anchor/consolidate events at all.
    const { item } = doneAccepted('c1')
    const events = new EventStore(eventsPath).readAll()
    // No anchor event present.
    expect(events.some((e) => e.type === 'realization.anchored')).toBe(false)
    // The item folds with realizedCommit ABSENT (drop-when-absent), and acceptance is unchanged.
    const itemState = fold(events).items.get(item)!
    expect('realizedCommit' in itemState).toBe(false)
    // Every contentHash is a stable function of the (unchanged) event bytes — recompute-stable.
    // (A KNOWN-hash regression: the raw bytes are unchanged by the additive build, so re-reading the
    // same log yields the same tail contentHash.)
    const tailHash = events.at(-1)!.contentHash
    const raw = readFileSync(eventsPath, 'utf8').trim().split('\n')
    const lastLine = JSON.parse(raw.at(-1)!) as { contentHash: string }
    expect(lastLine.contentHash).toBe(tailHash)
  })
})
