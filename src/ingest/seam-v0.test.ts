// harness↔track seam v0 FREEZE (track-side) — TDD for the two additive fields, the M1 runId-collision
// regression fixture, and the structural-inertness invariants the freeze relies on. Grounds against
// docs/plan/harness-seam-v0-FREEZE-DESIGN.md §9 (ratified) + §5 (test plan).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { computeHash } from '../events/canonical.js'
import { stripFrame } from '../events/frame.js'
import { EventStore } from '../events/store.js'
import type { Provenance, TrackEvent, Ulid } from '../events/types.js'
import { bucketOf } from '../report/buckets.js'
import { statusByLevel } from '../report/status-by-level.js'
import { fold } from '../state/fold.js'
import { INGEST_CONTRACT_VERSION } from './contract.js'
import type { WorkEvent, WorkEventKind } from './contract.js'
import { ingest, type IngestContext } from './ingest.js'
import { READ_CONTRACT_VERSION, TrackReader } from '../read/contract.js'

const now = (): string => '2026-06-09T00:00:00.000Z'
const counter = (): (() => Ulid) => {
  let i = 0
  return () => `id-${String(++i).padStart(4, '0')}`
}
const SIGNED: Provenance = { transport: 'import', proposed: false, auth: 'signed' }
const LOCAL: Provenance = { transport: 'import', proposed: false, auth: 'local-user' }
const ev = (kind: WorkEventKind, payload: Record<string, unknown>): WorkEvent => ({ v: 1, kind, payload })

let dir: string
let n = 0
let lastPath = ''
const freshStore = (): EventStore => {
  lastPath = join(dir, `s${++n}`, '.track', 'events.jsonl')
  return new EventStore(lastPath)
}
const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({ by: 'harness:t', workspace: 'ws', prov: SIGNED, ...over })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-seamv0-'))
  n = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const VRUN = { runId: 'vr-1', runner: 'stp-scope', commit: 'c1', verdict: 'clean' as const }

describe('seam v0 — contract version bumps (additive, backward-compatible)', () => {
  it('INGEST_CONTRACT_VERSION ≥ seam-v0 1.1.0 (now 1.3.0 — demand-lifecycle additive kinds, still MINOR)', () => {
    expect(INGEST_CONTRACT_VERSION).toBe('1.3.0')
  })
  it('READ_CONTRACT_VERSION ≥ seam-v0 1.9.0 (now 1.12.0 — demand lease/reads additive surface, still MINOR)', () => {
    expect(READ_CONTRACT_VERSION).toBe('1.12.0')
  })
})

describe('seam v0 — S2 artifactLocator on scope.verification (additive optional)', () => {
  it('round-trips an artifactLocator into verificationRuns and surfaces it on the read', () => {
    const store = freshStore()
    ingest(
      [ev('scope.verification', { ...VRUN, runId: 'vr-loc', artifactLocator: 'sha256:abc/run.json' })],
      ctx({ newId: counter(), now }),
      store,
    )
    const run = fold(store.readAll()).verificationRuns.get('vr-loc')
    expect(run).toMatchObject({ runId: 'vr-loc', artifactLocator: 'sha256:abc/run.json' })
    // read surface carries it verbatim
    const fromRead = new TrackReader(lastPath).verificationRuns()
    expect(fromRead.find((r) => r.runId === 'vr-loc')?.artifactLocator).toBe('sha256:abc/run.json')
  })

  it('drops artifactLocator when absent (hash-minimal; field omitted from the folded run)', () => {
    const store = freshStore()
    ingest([ev('scope.verification', { ...VRUN, runId: 'vr-noloc' })], ctx({ newId: counter(), now }), store)
    const run = fold(store.readAll()).verificationRuns.get('vr-noloc')!
    expect('artifactLocator' in run).toBe(false)
  })

  it('rejects an EMPTY-string artifactLocator (non-empty when present)', () => {
    const store = freshStore()
    expect(() =>
      ingest([ev('scope.verification', { ...VRUN, runId: 'vr-empty', artifactLocator: '' })], ctx({ newId: counter(), now }), store),
    ).toThrow()
  })

  it('ADDITIVE-HASH: current code reproduces a HARDCODED 0.12.0 pre-freeze contentHash (byte-identical)', () => {
    // The drift-proof additive-hash gate. Rather than writing the SAME current-code stream twice (which only
    // proves current==current), we PIN the contentHash of a `scope.verification-recorded` core EXACTLY as it
    // serialized at 0.12.0 (pre-freeze: NO artifactLocator field). The current fold + computeHash MUST
    // reproduce this literal — proving the additive `artifactLocator` left the persisted byte form unchanged
    // for a feature-absent event (the frozen-contract invariant: old logs fold byte-identically).
    //
    // GOLDEN: captured by replaying the pre-freeze payload below through ingest with FIXED id/at/by/prov and
    // stripping the integrity frame. This literal is a constant — it MUST NOT be re-derived from current code.
    const PRE_FREEZE_CONTENT_HASH = 'sha256:1f59e74845985b3f7c9d637938b69724df9b17aeb75f5d59ddd578e54fb48544'

    const store = freshStore()
    ingest(
      // The pre-freeze payload shape: runId/runner/commit/verdict + env + violations, NO artifactLocator.
      [ev('scope.verification', { runId: 'GOLD-0', runner: 'stp-scope', commit: 'cafe', verdict: 'violation', env: 'ci', violations: ['src/a.ts', 'src/b.ts'] })],
      ctx({ by: 'harness:t', workspace: 'ws', prov: SIGNED, now, newId: counter() }),
      store,
    )
    const recorded = store.readAll().find((e) => e.type === 'scope.verification-recorded')!
    // (a) the persisted payload carries NO artifactLocator key (drop-when-absent ⇒ hash-minimal) ...
    expect('artifactLocator' in (recorded.payload as Record<string, unknown>)).toBe(false)
    // (b) ... so its contentHash + a re-computed hash over the stripped core both EQUAL the 0.12.0 literal.
    expect(recorded.contentHash).toBe(PRE_FREEZE_CONTENT_HASH)
    expect(computeHash(stripFrame(recorded))).toBe(PRE_FREEZE_CONTENT_HASH)
    // (c) and the fold reproduces the expected VerificationRun (the feature is purely additive at the read).
    const run = fold(store.readAll()).verificationRuns.get('GOLD-0')!
    expect(run).toMatchObject({ runId: 'GOLD-0', runner: 'stp-scope', commit: 'cafe', verdict: 'violation', env: 'ci', violations: ['src/a.ts', 'src/b.ts'] })
    expect('artifactLocator' in run).toBe(false)
  })
})

describe('seam v0 — M2=B caller-supplied deterministic evidenceId on acceptance.link', () => {
  // Build an item + criterion so a link/run round-trips.
  const seed = (store: EventStore): string => {
    const item = ingest(
      [ev('item.create', { kind: 'feature', title: 'F', workspace: 'ws' })],
      ctx({ newId: counter(), now, prov: LOCAL }),
      store,
    ).ids[0]!
    const crit = ingest(
      [ev('acceptance.criterion', { itemId: item, statement: 'S' })],
      ctx({ prov: LOCAL }),
      store,
    ).ids[0]!
    return crit
  }

  it('HONORS a caller-supplied evidenceId (deterministic id round-trips through the fold)', () => {
    const store = freshStore()
    const crit = seed(store)
    const res = ingest(
      [ev('acceptance.link', { criterionId: crit, kind: 'unit', locator: 'file://t', evidenceId: 'ev-det-1' })],
      ctx({ prov: LOCAL }),
      store,
    )
    expect(res.ids[0]).toBe('ev-det-1') // the persisted id is the caller-supplied one
    expect(fold(store.readAll()).evidence.get('ev-det-1')).toMatchObject({ id: 'ev-det-1', criterionId: crit })
  })

  it('acceptance.run referencing the SAME deterministic evidenceId resolves (recordRun does NOT throw)', () => {
    const store = freshStore()
    const crit = seed(store)
    ingest(
      [ev('acceptance.link', { criterionId: crit, kind: 'unit', locator: 'file://t', evidenceId: 'ev-det-2' })],
      ctx({ prov: LOCAL }),
      store,
    )
    // The harness can predict ev-det-2 and emit a run against it (no two-phase read needed).
    ingest(
      [ev('acceptance.run', { evidenceId: 'ev-det-2', commit: 'c1', env: 'ci', runner: 'vitest', result: 'pass' })],
      ctx({ prov: LOCAL }),
      store,
    )
    const evidence = fold(store.readAll()).evidence.get('ev-det-2')!
    expect(evidence.latestRun).toMatchObject({ evidenceId: 'ev-det-2', result: 'pass' })
  })

  it('ABSENT evidenceId ⇒ shipped server-mint behavior unchanged (back-compat)', () => {
    const store = freshStore()
    const crit = seed(store)
    const res = ingest(
      [ev('acceptance.link', { criterionId: crit, kind: 'unit', locator: 'file://t' })],
      ctx({ newId: counter(), prov: LOCAL }),
      store,
    )
    // a server-minted id (the counter id), not undefined — and it folds into evidence
    expect(typeof res.ids[0]).toBe('string')
    expect(fold(store.readAll()).evidence.get(res.ids[0]!)).toBeDefined()
  })

  it('rejects an EMPTY-string evidenceId on acceptance.link (non-empty when present)', () => {
    const store = freshStore()
    const crit = seed(store)
    expect(() =>
      ingest([ev('acceptance.link', { criterionId: crit, kind: 'unit', locator: 'file://t', evidenceId: '' })], ctx({ prov: LOCAL }), store),
    ).toThrow()
  })

  it('clientToken-deduped re-link with the same deterministic evidenceId returns the SAME id (no second evidence)', () => {
    const store = freshStore()
    const crit = seed(store)
    const stream = [
      { v: 1 as const, kind: 'acceptance.link' as const, payload: { criterionId: crit, kind: 'unit', locator: 'file://t', evidenceId: 'ev-det-3' }, clientToken: 'lnk-tok' },
    ]
    const a = ingest(stream, ctx({ prov: LOCAL }), store)
    const b = ingest(stream, ctx({ prov: LOCAL }), store)
    expect(a.ids[0]).toBe('ev-det-3')
    expect(b.ids[0]).toBe('ev-det-3') // deduped — original id returned
    expect(store.readAll().filter((e) => e.type === 'acceptance.evidence.linked').length).toBe(1)
  })
})

describe('seam v0 — caller-supplied evidenceId COLLISION guard (fail-closed containment)', () => {
  // Seed an item + criterion in a NAMED workspace so we can build same- and cross-workspace cases. A SHARED
  // id generator is threaded through every write so item/criterion ids never collide across seeds.
  const seedIn = (store: EventStore, workspace: string, mint: () => Ulid): string => {
    const item = ingest(
      [ev('item.create', { kind: 'feature', title: 'F', workspace })],
      ctx({ newId: mint, now, prov: LOCAL, workspace }),
      store,
    ).ids[0]!
    const crit = ingest(
      [ev('acceptance.criterion', { itemId: item, statement: 'S' })],
      ctx({ newId: mint, prov: LOCAL, workspace }),
      store,
    ).ids[0]!
    return crit
  }

  it('SAME-workspace: re-using a caller-supplied evidenceId already linked THROWS (no silent re-point)', () => {
    const store = freshStore()
    const mint = counter()
    const critA = seedIn(store, 'ws', mint)
    const critB = seedIn(store, 'ws', mint)
    ingest([ev('acceptance.link', { criterionId: critA, kind: 'unit', locator: 'file://a', evidenceId: 'ev-dup' })], ctx({ prov: LOCAL }), store)
    // A second caller-supplied link re-using 'ev-dup' (now pointed at a DIFFERENT criterion) must be rejected
    // BEFORE any append — the fold's blind last-writer-wins set would otherwise silently re-point the evidence.
    expect(() =>
      ingest([ev('acceptance.link', { criterionId: critB, kind: 'unit', locator: 'file://b', evidenceId: 'ev-dup' })], ctx({ prov: LOCAL }), store),
    ).toThrow(/already exists/)
    // No second link persisted — the original (critA) entry is intact.
    expect(store.readAll().filter((e) => e.type === 'acceptance.evidence.linked').length).toBe(1)
    expect(fold(store.readAll()).evidence.get('ev-dup')).toMatchObject({ criterionId: critA })
  })

  it('CROSS-workspace: a V-channel cannot re-use an evidenceId already linked by W (global-map clobber blocked)', () => {
    const store = freshStore()
    const mint = counter()
    const critW = seedIn(store, 'W', mint)
    const critV = seedIn(store, 'V', mint)
    // W links ev-X on its criterion.
    ingest([ev('acceptance.link', { criterionId: critW, kind: 'unit', locator: 'file://w', evidenceId: 'ev-X' })], ctx({ prov: LOCAL, workspace: 'W' }), store)
    // V tries to re-use ev-X — the guard fires BEFORE the workspace-containment denial would (existence-first,
    // fail-closed), so the global evidence map can never be clobbered to re-point W's id at V's criterion.
    expect(() =>
      ingest([ev('acceptance.link', { criterionId: critV, kind: 'unit', locator: 'file://v', evidenceId: 'ev-X' })], ctx({ prov: LOCAL, workspace: 'V' }), store),
    ).toThrow(/already exists/)
    // W's later run still routes to W (the evidence map was not corrupted).
    expect(fold(store.readAll()).evidence.get('ev-X')).toMatchObject({ criterionId: critW })
    expect(() =>
      ingest([ev('acceptance.run', { evidenceId: 'ev-X', commit: 'c1', env: 'ci', runner: 'vitest', result: 'pass' })], ctx({ prov: LOCAL, workspace: 'W' }), store),
    ).not.toThrow()
  })

  it('a FRESHLY-MINTED id (input absent) never trips the guard (ULID is collision-free)', () => {
    const store = freshStore()
    const mint = counter()
    const crit = seedIn(store, 'ws', mint)
    // Two distinct server-minted links on the same criterion — neither is caller-supplied, so the guard never fires.
    const a = ingest([ev('acceptance.link', { criterionId: crit, kind: 'unit', locator: 'file://1' })], ctx({ newId: mint, prov: LOCAL }), store)
    const b = ingest([ev('acceptance.link', { criterionId: crit, kind: 'unit', locator: 'file://2' })], ctx({ newId: mint, prov: LOCAL }), store)
    expect(a.ids[0]).not.toBe(b.ids[0])
    expect(store.readAll().filter((e) => e.type === 'acceptance.evidence.linked').length).toBe(2)
  })

  it('a fresh DISTINCT caller-supplied id links fine (the guard only rejects a collision)', () => {
    const store = freshStore()
    const crit = seedIn(store, 'ws', counter())
    ingest([ev('acceptance.link', { criterionId: crit, kind: 'unit', locator: 'file://1', evidenceId: 'ev-A' })], ctx({ prov: LOCAL }), store)
    expect(() =>
      ingest([ev('acceptance.link', { criterionId: crit, kind: 'unit', locator: 'file://2', evidenceId: 'ev-B' })], ctx({ prov: LOCAL }), store),
    ).not.toThrow()
    expect(store.readAll().filter((e) => e.type === 'acceptance.evidence.linked').length).toBe(2)
  })

  it('a clientToken-deduped retry of a caller-supplied link does NOT trip the guard (dedup absorbs UPSTREAM)', () => {
    const store = freshStore()
    const crit = seedIn(store, 'ws', counter())
    const stream = [
      { v: 1 as const, kind: 'acceptance.link' as const, payload: { criterionId: crit, kind: 'unit', locator: 'file://t', evidenceId: 'ev-retry' }, clientToken: 'lnk-retry' },
    ]
    const a = ingest(stream, ctx({ prov: LOCAL }), store)
    // The identical retry is absorbed by the clientToken dedup fast-path (returns the original id BEFORE
    // linkEvidence re-runs), so the new existence-guard must NOT fire on it.
    const b = ingest(stream, ctx({ prov: LOCAL }), store)
    expect(a.ids[0]).toBe('ev-retry')
    expect(b.ids[0]).toBe('ev-retry')
    expect(store.readAll().filter((e) => e.type === 'acceptance.evidence.linked').length).toBe(1)
  })
})

describe('seam v0 — caller-supplied evidenceId guard is TOKEN-AWARE (0.12.0 concurrent-retry seam intact)', () => {
  // The collision guard must distinguish "my own concurrent retry" (same delivery — must NOT throw, let the
  // under-lock dedup return the original) from "a different command re-using the id" (real collision — throw).
  //
  // The precise race (Codex-verified): the ingest fast-path `tokenIndex` is built ONCE at ingest start from a
  // pre-commit snapshot (STALE — token absent ⇒ miss), so the retry proceeds INTO linkEvidence. By then the
  // concurrent first writer has committed, so linkEvidence's FRESH `this.state()` fold SEES `ev-conc` — and a
  // token-BLIND guard throws `already exists` BEFORE the under-lock workspaceDedupe can return the original.
  //
  // Harness: the FIRST readAll() (the one the fast-path `tokenIndex` consumes) returns the stale pre-link
  // snapshot; EVERY subsequent readAll() (linkEvidence's `this.state()` fold + the under-lock recheck) returns
  // the CURRENT log. That isolates exactly this bug — stale fast-path, fresh facade fold — unlike the
  // all-views-stale StaleUntilLockStore (which would also hide the linkEvidence fold and mask the regression).
  class StaleFastPathStore extends EventStore {
    private served = false
    constructor(path: string, private readonly staleSnapshot: ReturnType<EventStore['readAll']>) {
      super(path)
    }
    override readAll(): ReturnType<EventStore['readAll']> {
      if (!this.served) {
        this.served = true // only the fast-path tokenIndex read is stale; all later folds are current
        return this.staleSnapshot
      }
      return super.readAll()
    }
  }

  const seedIn = (store: EventStore, workspace: string, mint: () => Ulid): string => {
    const item = ingest(
      [ev('item.create', { kind: 'feature', title: 'F', workspace })],
      ctx({ newId: mint, now, prov: LOCAL, workspace }),
      store,
    ).ids[0]!
    const crit = ingest(
      [ev('acceptance.criterion', { itemId: item, statement: 'S' })],
      ctx({ newId: mint, prov: LOCAL, workspace }),
      store,
    ).ids[0]!
    return crit
  }

  it('REGRESSION: a concurrent (fast-path-defeated) SAME-token retry of a caller-supplied evidenceId does NOT throw — dedups to ONE, returns the ORIGINAL', () => {
    const path = join(dir, 'concurrent-retry', '.track', 'events.jsonl')
    const store = new EventStore(path)
    const crit = seedIn(store, 'ws', counter())
    const link = [
      { v: 1 as const, kind: 'acceptance.link' as const, payload: { criterionId: crit, kind: 'unit', locator: 'file://t', evidenceId: 'ev-conc' }, clientToken: 'lnk-conc' },
    ]
    const r1 = ingest(link, ctx({ prov: LOCAL }), store) // first writer commits acceptance.evidence.linked
    expect(r1.ids[0]).toBe('ev-conc')
    const after1 = store.readAll().length

    // The racing retry: its fast-path tokenIndex is built from the PRE-link snapshot (token absent ⇒ miss), so
    // it proceeds INTO linkEvidence — whose FRESH state() fold (current log) now SEES the first writer's
    // committed ev-conc. A token-BLIND guard throws `already exists` HERE, before the under-lock dedup runs.
    // Token-aware: same delivery (existing.originClientToken === active token) ⇒ NO throw ⇒ the under-lock
    // workspaceDedupe returns the ORIGINAL persisted event (idempotent).
    const staleSnapshot = store.readAll().filter((e) => e.type !== 'acceptance.evidence.linked')
    const racing = new StaleFastPathStore(path, staleSnapshot)
    let r2!: ReturnType<typeof ingest>
    expect(() => {
      r2 = ingest(link, ctx({ prov: LOCAL }), racing)
    }).not.toThrow() // BEFORE the fix: throws `acceptance.link: evidence ev-conc already exists`
    expect(store.readAll().length).toBe(after1) // the under-lock dedup suppressed the duplicate
    expect(store.readAll().filter((e) => e.type === 'acceptance.evidence.linked').length).toBe(1) // ONE event
    expect(r2.ids[0]).toBe('ev-conc') // returns the ORIGINAL persisted evidenceId
  })

  it('a DIFFERENT clientToken re-using the SAME caller-supplied evidenceId is a genuine collision ⇒ THROWS (no clobber)', () => {
    const store = freshStore()
    const crit = seedIn(store, 'ws', counter())
    // First link under token A.
    ingest(
      [{ v: 1 as const, kind: 'acceptance.link' as const, payload: { criterionId: crit, kind: 'unit', locator: 'file://1', evidenceId: 'ev-dt' }, clientToken: 'tok-A' }],
      ctx({ prov: LOCAL }),
      store,
    )
    // A NEW command (token B) re-using ev-dt — origin token (A) !== active token (B) ⇒ real collision ⇒ throw.
    expect(() =>
      ingest(
        [{ v: 1 as const, kind: 'acceptance.link' as const, payload: { criterionId: crit, kind: 'unit', locator: 'file://2', evidenceId: 'ev-dt' }, clientToken: 'tok-B' }],
        ctx({ prov: LOCAL }),
        store,
      ),
    ).toThrow(/already exists/)
    expect(store.readAll().filter((e) => e.type === 'acceptance.evidence.linked').length).toBe(1)
  })

  it('an UNTOKENED re-use of a tokened evidenceId still THROWS (no active token ⇒ fail-closed)', () => {
    const store = freshStore()
    const crit = seedIn(store, 'ws', counter())
    ingest(
      [{ v: 1 as const, kind: 'acceptance.link' as const, payload: { criterionId: crit, kind: 'unit', locator: 'file://1', evidenceId: 'ev-ut' }, clientToken: 'tok-A' }],
      ctx({ prov: LOCAL }),
      store,
    )
    expect(() =>
      ingest([ev('acceptance.link', { criterionId: crit, kind: 'unit', locator: 'file://2', evidenceId: 'ev-ut' })], ctx({ prov: LOCAL }), store),
    ).toThrow(/already exists/)
  })

  it('SEQUENTIAL same-token retry (fast-path absorbs it BEFORE linkEvidence) still returns the original (unchanged)', () => {
    const store = freshStore()
    const crit = seedIn(store, 'ws', counter())
    const stream = [
      { v: 1 as const, kind: 'acceptance.link' as const, payload: { criterionId: crit, kind: 'unit', locator: 'file://t', evidenceId: 'ev-seq' }, clientToken: 'lnk-seq' },
    ]
    const a = ingest(stream, ctx({ prov: LOCAL }), store)
    const b = ingest(stream, ctx({ prov: LOCAL }), store) // fast-path tokenIndex hit ⇒ never reaches linkEvidence
    expect(a.ids[0]).toBe('ev-seq')
    expect(b.ids[0]).toBe('ev-seq')
    expect(store.readAll().filter((e) => e.type === 'acceptance.evidence.linked').length).toBe(1)
  })
})

describe('seam v0 — M1 runId-collision regression fixture (cross-contract invariant track relies on)', () => {
  it('two scope.verification events sharing ONE runId COLLAPSE to one in verificationRuns (N-1 lost)', () => {
    // INVARIANT (RATIFIED, harness-owned): state.verificationRuns is keyed by BARE runId (fold.ts). The
    // adapter MUST mint a globally-unique runId PER EMITTED VERDICT. If it reuses one physical runId across
    // N fanned-out scope verdicts, the read Map collapses to ONE (last-in-stream wins) and N-1 verdicts are
    // SILENTLY LOST from the read surface + scope-validate. track does NOT re-key (re-keying breaks the read
    // contract + the wpRef-absent run has no key). This fixture PINS the data-loss so a harness regression is
    // caught cross-contract.
    const store = freshStore()
    const wpA = ingest([ev('item.create', { kind: 'chore', title: 'WP-A', workspace: 'ws', role: 'workpackage' })], ctx({ prov: LOCAL }), store).ids[0]!
    const wpB = ingest([ev('item.create', { kind: 'chore', title: 'WP-B', workspace: 'ws', role: 'workpackage' })], ctx({ prov: LOCAL }), store).ids[0]!
    // Two DISTINCT scope verdicts (different wpRef) but the SAME (illegally-reused) runId.
    ingest([ev('scope.verification', { runId: 'PHYS-1', runner: 'stp', commit: 'c1', verdict: 'clean', wpRef: wpA })], ctx({ prov: LOCAL }), store)
    ingest([ev('scope.verification', { runId: 'PHYS-1', runner: 'stp', commit: 'c1', verdict: 'violation', wpRef: wpB, violations: ['src/x.ts'] })], ctx({ prov: LOCAL }), store)
    const runs = fold(store.readAll()).verificationRuns
    // BOTH events PERSIST...
    expect(store.readAll().filter((e) => e.type === 'scope.verification-recorded').length).toBe(2)
    // ...but the read Map COLLAPSES to ONE (the collision the harness MUST avoid by minting per-verdict ids).
    expect(runs.size).toBe(1)
    expect(runs.get('PHYS-1')!.wpRef).toBe(wpB) // last-in-stream won; the wpA verdict is lost
  })

  it('DISTINCT runIds per emitted verdict preserve both (the invariant satisfied ⇒ no loss)', () => {
    const store = freshStore()
    const wpA = ingest([ev('item.create', { kind: 'chore', title: 'WP-A', workspace: 'ws', role: 'workpackage' })], ctx({ prov: LOCAL }), store).ids[0]!
    const wpB = ingest([ev('item.create', { kind: 'chore', title: 'WP-B', workspace: 'ws', role: 'workpackage' })], ctx({ prov: LOCAL }), store).ids[0]!
    ingest([ev('scope.verification', { runId: 'PHYS-1#0', runner: 'stp', commit: 'c1', verdict: 'clean', wpRef: wpA })], ctx({ prov: LOCAL }), store)
    ingest([ev('scope.verification', { runId: 'PHYS-1#1', runner: 'stp', commit: 'c1', verdict: 'violation', wpRef: wpB })], ctx({ prov: LOCAL }), store)
    expect(fold(store.readAll()).verificationRuns.size).toBe(2)
  })
})

describe('seam v0 — status(level) unaffected by a verdict (structural inertness)', () => {
  it('a violation scope.verification on a wpRef whose leaves are all done does NOT change its bucket/rollup', () => {
    const store = freshStore()
    const wpRef = ingest([ev('item.create', { kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })], ctx({ prov: LOCAL }), store).ids[0]!
    const leaf = ingest([ev('item.create', { kind: 'feature', title: 'L', workspace: 'ws', parentId: wpRef })], ctx({ prov: LOCAL }), store).ids[0]!
    ingest([ev('item.spec', { itemId: leaf, to: 'specified' })], ctx({ prov: LOCAL }), store)
    ingest([ev('item.realize', { itemId: leaf, to: 'in-progress' })], ctx({ prov: LOCAL }), store)
    ingest([ev('item.realize', { itemId: leaf, to: 'done' })], ctx({ prov: LOCAL }), store)
    const config = { baselineCommit: 'c1', requireAccepted: false }
    const before = statusByLevel(fold(store.readAll()), 'wp', config)
    const leafBucketBefore = bucketOf(fold(store.readAll()), fold(store.readAll()).items.get(leaf)!, config)

    ingest([ev('scope.verification', { ...VRUN, runId: 'vr-inert', wpRef, verdict: 'violation', violations: ['src/x.ts'], artifactLocator: 'sha256:run' })], ctx({ prov: LOCAL }), store)

    const after = statusByLevel(fold(store.readAll()), 'wp', config)
    expect(after).toEqual(before) // WP rollup unchanged by the path verdict
    expect(bucketOf(fold(store.readAll()), fold(store.readAll()).items.get(leaf)!, config)).toBe(leafBucketBefore)
  })
})

describe('seam v0 — frozen contract golden replay unchanged', () => {
  it('a pre-freeze event stream folds + replays byte-identically (verification feature is purely additive)', () => {
    const replay = (store: EventStore): void => {
      const c = counter()
      const item = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx({ newId: c, now, prov: LOCAL }), store).ids[0]!
      ingest([ev('item.spec', { itemId: item, to: 'specified' })], ctx({ newId: c, now, prov: LOCAL }), store)
    }
    const a = freshStore()
    replay(a)
    const events = a.readAll() as TrackEvent[]
    expect(events.every((e) => e.type !== 'scope.verification-recorded' && e.type !== 'acceptance.evidence.linked')).toBe(true)
    const b = freshStore()
    replay(b)
    expect(b.readAll()).toEqual(events) // identical seq/hash — the seam is purely additive
  })
})
