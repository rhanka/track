import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readHead } from '../events/head.js'
import { EventStore } from '../events/store.js'
import type { Provenance } from '../events/types.js'
import { validate } from '../events/validate.js'
import type { WorkEvent, WorkEventKind } from './contract.js'
import { ingest, type IngestContext } from './ingest.js'

const PROV: Provenance = { transport: 'import', proposed: false, auth: 'local-user' }
const WSJF = { userBusinessValue: 1, timeCriticality: 1, riskReductionOpportunityEnablement: 1, jobSize: 2 }
const ev = (kind: WorkEventKind, payload: Record<string, unknown>, clientToken?: string): WorkEvent => ({
  v: 1,
  kind,
  payload,
  ...(clientToken !== undefined ? { clientToken } : {}),
})

let dir: string
let n = 0
const pathFor = (): string => join(dir, `s${++n}`, '.track', 'events.jsonl')
const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({ by: 'human:t', workspace: 'ws', prov: PROV, ...over })
const created = (path: string): number => new EventStore(path).readAll().filter((e) => e.type === 'item.created').length

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-idem-'))
  n = 0
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ingest idempotency — clientToken skip with stable ids', () => {
  it('re-ingesting a tokened stream is a no-op and returns the SAME ids', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const stream = [ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }, 't-1')]
    const r1 = ingest(stream, ctx(), store)
    const after1 = store.readAll().length
    const r2 = ingest(stream, ctx(), store)
    expect(store.readAll().length).toBe(after1) // nothing re-applied
    expect(r2.ids).toEqual(r1.ids) // stable id on skip
  })

  it('an UNtokened stream still re-applies on re-ingest (at-least-once preserved)', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const stream = [ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })] // no token
    ingest(stream, ctx(), store)
    ingest(stream, ctx(), store)
    expect(created(path)).toBe(2)
  })

  it('skips a tokened transition replay instead of throwing "illegal transition"', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
    const spec = [ev('item.spec', { itemId, to: 'specified' }, 'spec-1')]
    ingest(spec, ctx(), store)
    // Without the token this would throw `specified -> specified`; the token makes the retry never reach the machine.
    expect(() => ingest(spec, ctx(), store)).not.toThrow()
    expect(store.readAll().filter((e) => e.type === 'spec.transition').length).toBe(1)
  })

  it('prevents duplicate criterion + priority on a tokened retry, with stable ids', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
    const stream = [
      ev('acceptance.criterion', { itemId, statement: 's' }, 'crit-1'),
      ev('priority.assess', { itemId, ...WSJF }, 'pri-1'),
    ]
    const r1 = ingest(stream, ctx(), store)
    const r2 = ingest(stream, ctx(), store)
    expect(store.readAll().filter((e) => e.type === 'acceptance.criterion.added').length).toBe(1)
    expect(store.readAll().filter((e) => e.type === 'priority.assessed').length).toBe(1)
    expect(r2.ids).toEqual(r1.ids) // criterion id + the null for assess both stable
  })

  it('a retry skips the committed prefix and applies only the new suffix (resume-after-partial)', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }, 'c-2')], ctx(), store).ids[0]!
    ingest([ev('item.spec', { itemId, to: 'specified' }, 's-2')], ctx(), store)
    const before = store.readAll().length
    const r = ingest(
      [
        ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }, 'c-2'), // skip
        ev('item.spec', { itemId, to: 'specified' }, 's-2'), // skip
        ev('item.realize', { itemId, to: 'in-progress' }, 'rz-2'), // NEW → apply
      ],
      ctx(),
      store,
    )
    expect(r.ids[0]).toBe(itemId) // stable id for the skipped create
    expect(store.readAll().length).toBe(before + 1) // only the new realize appended
  })

  it('also skips an intra-stream duplicate token (same token twice in one file)', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const r = ingest(
      [
        ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }, 'dup'),
        ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }, 'dup'), // same token → skip
      ],
      ctx(),
      store,
    )
    expect(created(path)).toBe(1)
    expect(r.ids[0]).toBe(r.ids[1]) // the duplicate returns the first's id
  })

  it('a tampered clientToken is detected (it is hash-covered)', () => {
    const path = pathFor()
    const store = new EventStore(path)
    ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }, 'tok-x')], ctx(), store)
    expect(validate(store.readAll(), readHead(path)).ok).toBe(true)
    writeFileSync(path, readFileSync(path, 'utf8').replace('tok-x', 'tok-Y'))
    expect(validate(store.readAll(), readHead(path)).ok).toBe(false) // contentHash no longer matches
  })

  it('mixes tokened and untokened events; re-ingest re-applies only the untokened', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const stream = [
      ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }), // untokened
      ev('item.create', { kind: 'bug', title: 'B', workspace: 'ws' }, 'b-1'), // tokened
    ]
    ingest(stream, ctx(), store)
    expect(validate(store.readAll(), readHead(path)).ok).toBe(true)
    ingest(stream, ctx(), store)
    expect(created(path)).toBe(3) // untokened re-applied (2), tokened skipped (still 1)
  })

  it('skips a tokened decision.create batch WHOLESALE on retry, returning the decisionId', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
    const dstream = [
      ev('decision.create', { decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [itemId], dossier: { context: '', options: [], qa: [] } }, 'dec-1'),
    ]
    const r1 = ingest(dstream, ctx(), store)
    const after1 = store.readAll().length // decision.created + 1 blocker.opened
    const r2 = ingest(dstream, ctx(), store)
    expect(store.readAll().length).toBe(after1) // the whole cmdId batch skipped
    expect(r2.ids).toEqual(r1.ids) // returns the decisionId
  })

  it('skips a tokened no-go outcome batch on retry (no illegal-transition throw)', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
    const decId = ingest(
      [ev('decision.create', { decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [itemId], dossier: { context: '', options: [], qa: [] } })],
      ctx(),
      store,
    ).ids[0]!
    const out = [ev('decision.outcome', { decisionId: decId, to: 'no-go' }, 'out-1')]
    ingest(out, ctx(), store)
    const after = store.readAll().length // outcome + blocker.resolved + realization→rejected
    expect(() => ingest(out, ctx(), store)).not.toThrow() // otherwise: illegal outcome transition (already no-go)
    expect(store.readAll().length).toBe(after)
  })

  it('returns stable ids for tokened blocker.raise and acceptance.link retries', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
    const critId = ingest([ev('acceptance.criterion', { itemId, statement: 's' })], ctx(), store).ids[0]!
    const stream = [
      ev('acceptance.link', { criterionId: critId, kind: 'unit', locator: 'l' }, 'lnk-1'), // resultIdOf reads payload.evidenceId
      ev('blocker.raise', { targetId: itemId, kind: 'dependency', ref: itemId }, 'blk-1'), // resultIdOf reads aggregateId
    ]
    const r1 = ingest(stream, ctx(), store)
    const after1 = store.readAll().length
    const r2 = ingest(stream, ctx(), store)
    expect(store.readAll().length).toBe(after1) // both skipped
    expect(r2.ids).toEqual(r1.ids) // evidenceId + blockerId both stable
    expect(r2.ids.every((x) => x !== null)).toBe(true)
  })

  it('scopes tokens PER WORKSPACE — a colliding token from another workspace does NOT suppress the write', () => {
    const path = pathFor()
    const store = new EventStore(path)
    const vId = ingest([ev('item.create', { kind: 'feature', title: 'V', workspace: 'V' }, 'shared')], ctx({ workspace: 'V' }), store).ids[0]!
    const before = created(path)
    const r = ingest([ev('item.create', { kind: 'feature', title: 'W', workspace: 'W' }, 'shared')], ctx({ workspace: 'W' }), store)
    expect(created(path)).toBe(before + 1) // the W write is NOT suppressed by V's identical token
    expect(r.ids[0]).not.toBe(vId) // and returns W's own new id, not V's
  })

  // ---- Concurrent-retry backstop (M3-channel): the under-lock recheck inside appendCommand ----
  describe('concurrent-retry race — the ingest fast-path is bypassed (both saw "absent")', () => {
    /**
     * A store that serves a frozen, STALE pre-commit snapshot to EVERY read OUTSIDE its own
     * `appendCommand` — the fast-path tokenIndex AND every facade fold (so the transition guard also sees
     * "absent", exactly as a genuine racing writer would) — while the read the lock takes INSIDE
     * `appendCommand` sees the real, current log. This is precisely the window the under-lock recheck must
     * close: every pre-append view is stale, only the in-lock re-read is current, so the in-lock recheck is
     * the ONLY thing that can dedup. (No read-counting: `inAppend` flips deterministically around the super
     * call, so it is robust to how many folds the facade happens to take.)
     */
    class StaleUntilLockStore extends EventStore {
      private inAppend = false
      constructor(path: string, private readonly staleSnapshot: ReturnType<EventStore['readAll']>) {
        super(path)
      }
      override readAll(): ReturnType<EventStore['readAll']> {
        return this.inAppend ? super.readAll() : this.staleSnapshot
      }
      override appendCommand(...args: Parameters<EventStore['appendCommand']>): ReturnType<EventStore['appendCommand']> {
        this.inAppend = true
        try {
          return super.appendCommand(...args)
        } finally {
          this.inAppend = false
        }
      }
    }

    it('a tokened TRANSITION retry whose every PRE-append view is stale is deduped by the under-lock recheck (one event, no throw)', () => {
      const path = pathFor()
      const store = new EventStore(path)
      const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
      const spec = [ev('item.spec', { itemId, to: 'specified' }, 'race-tok')]
      ingest(spec, ctx(), store) // first writer commits the tokened spec.transition
      const after1 = store.readAll().length

      // The racing retry: its fast-path index AND its facade fold are built from the PRE-spec snapshot
      // (token absent, item still 'to-do' so the transition guard passes). Only the readAll INSIDE
      // appendCommand under the lock is current; the under-lock recheck must dedup THERE.
      const staleSnapshot = store.readAll().filter((e) => e.type !== 'spec.transition')
      const racing = new StaleUntilLockStore(path, staleSnapshot)
      expect(() => ingest(spec, ctx(), racing)).not.toThrow() // no double-append, no illegal-transition throw
      expect(store.readAll().length).toBe(after1) // the under-lock recheck suppressed the duplicate
      expect(store.readAll().filter((e) => e.type === 'spec.transition').length).toBe(1)
    })

    it('the same all-views-stale retry in a DIFFERENT workspace/aggregate is NOT suppressed (namespacing holds under the lock)', () => {
      const path = pathFor()
      const store = new EventStore(path)
      const vId = ingest([ev('item.create', { kind: 'feature', title: 'V', workspace: 'V' })], ctx({ workspace: 'V' }), store).ids[0]!
      const wId = ingest([ev('item.create', { kind: 'feature', title: 'W', workspace: 'W' })], ctx({ workspace: 'W' }), store).ids[0]!
      ingest([ev('item.spec', { itemId: vId, to: 'specified' }, 'ns-tok')], ctx({ workspace: 'V' }), store)
      const beforeW = store.readAll().filter((e) => e.type === 'spec.transition').length

      // W's transition carries the SAME token but addresses a DIFFERENT aggregate (wId). Even with every
      // pre-append view stale, the under-lock recheck — scoped by (workspace, clientToken) — must NOT
      // suppress it (the token is present only on V's aggregate/workspace, never W's).
      const staleSnapshot = store.readAll().filter((e) => e.type !== 'spec.transition')
      const racing = new StaleUntilLockStore(path, staleSnapshot)
      ingest([ev('item.spec', { itemId: wId, to: 'specified' }, 'ns-tok')], ctx({ workspace: 'W' }), racing)
      expect(store.readAll().filter((e) => e.type === 'spec.transition').length).toBe(beforeW + 1) // W applied
    })

    // ---- Codex probe #1 — concurrent CREATE retry re-mints a fresh aggregateId per attempt ----
    it('a tokened CREATE retry whose every PRE-append view is stale yields ONE item.created and the ORIGINAL id', () => {
      const path = pathFor()
      const store = new EventStore(path)
      const create = [ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' }, 'race-create')]
      const r1 = ingest(create, ctx(), store) // first writer commits item.created (aggregateId = id #1)
      const firstId = r1.ids[0]!
      const after1 = store.readAll().length

      // The racing retry: every pre-append view is stale (token absent), so the fast-path misses AND the
      // facade re-mints a FRESH aggregateId for the second item.created. Keyed on (workspace, clientToken)
      // — independent of the re-minted aggregateId — the under-lock hook must dedup: ONE created, original id.
      const staleSnapshot = store.readAll().filter((e) => e.type !== 'item.created')
      const racing = new StaleUntilLockStore(path, staleSnapshot)
      const r2 = ingest(create, ctx(), racing)
      expect(store.readAll().length).toBe(after1) // no double-write
      expect(created(path)).toBe(1) // exactly ONE item.created in the log
      expect(r2.ids[0]).toBe(firstId) // returns the FIRST's persisted id, never the freshly-minted one
    })

    // ---- Codex probe #2 — under-lock dedup of a STABLE-aggregate op that mints a result id in the payload ----
    it('a tokened linkEvidence retry deduped under the lock returns the ORIGINAL persisted evidenceId (not the fresh one)', () => {
      const path = pathFor()
      const store = new EventStore(path)
      const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
      const critId = ingest([ev('acceptance.criterion', { itemId, statement: 's' })], ctx(), store).ids[0]!
      const link = [ev('acceptance.link', { criterionId: critId, kind: 'unit', locator: 'l' }, 'race-link')]
      const r1 = ingest(link, ctx(), store) // first writer commits acceptance.evidence.linked (evidenceId in payload)
      const firstEvidenceId = r1.ids[0]!
      const after1 = store.readAll().length

      // The racing retry: every pre-append view is stale (token absent), so the facade re-mints a FRESH
      // evidenceId INTO the payload. The aggregate (the item) is stable, so the under-lock hook dedups —
      // and ingest must derive the result id from the PERSISTED event, returning the ORIGINAL evidenceId.
      const staleSnapshot = store.readAll().filter((e) => e.type !== 'acceptance.evidence.linked')
      const racing = new StaleUntilLockStore(path, staleSnapshot)
      const r2 = ingest(link, ctx(), racing)
      expect(store.readAll().length).toBe(after1) // one event in the log
      expect(store.readAll().filter((e) => e.type === 'acceptance.evidence.linked').length).toBe(1)
      expect(r2.ids[0]).toBe(firstEvidenceId) // ORIGINAL persisted evidenceId, NOT the freshly-minted one
    })

    // ---- Result-id fidelity for the OTHER re-minting creators (mirror probe #1, aggregateId-valued) ----
    it('a tokened CREATE-DECISION retry whose every PRE-append view is stale yields ONE decision and the ORIGINAL id', () => {
      const path = pathFor()
      const store = new EventStore(path)
      const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
      const create = [
        ev('decision.create', { decisionKind: 'orientation', title: 'D', workspace: 'ws', targets: [itemId], dossier: { context: '', options: [], qa: [] } }, 'race-dec'),
      ]
      const r1 = ingest(create, ctx(), store) // first writer commits decision.created (+ blocker.opened)
      const firstId = r1.ids[0]!
      const after1 = store.readAll().length

      // The racing retry re-mints a FRESH decisionId; keyed on (workspace, clientToken) the under-lock hook
      // dedups — and ingest derives the result id from the PERSISTED batch, returning the ORIGINAL.
      const staleSnapshot = store.readAll().filter((e) => e.type !== 'decision.created' && e.type !== 'blocker.opened')
      const racing = new StaleUntilLockStore(path, staleSnapshot)
      const r2 = ingest(create, ctx(), racing)
      expect(store.readAll().length).toBe(after1) // no double-write
      expect(store.readAll().filter((e) => e.type === 'decision.created').length).toBe(1) // exactly ONE decision
      expect(r2.ids[0]).toBe(firstId) // returns the FIRST's persisted decisionId, never the freshly-minted one
    })

    it('a tokened OPEN-BLOCKER (blocker.raise) retry whose every PRE-append view is stale yields ONE blocker and the ORIGINAL id', () => {
      const path = pathFor()
      const store = new EventStore(path)
      const itemId = ingest([ev('item.create', { kind: 'feature', title: 'A', workspace: 'ws' })], ctx(), store).ids[0]!
      const raise = [ev('blocker.raise', { targetId: itemId, kind: 'dependency', ref: itemId }, 'race-blk')]
      const r1 = ingest(raise, ctx(), store) // first writer commits blocker.opened (aggregateId = blockerId #1)
      const firstId = r1.ids[0]!
      const after1 = store.readAll().length

      // The racing retry re-mints a FRESH blockerId (= a fresh aggregateId); keyed on (workspace,
      // clientToken) the under-lock hook dedups — and ingest derives the result id from the PERSISTED event.
      const staleSnapshot = store.readAll().filter((e) => e.type !== 'blocker.opened')
      const racing = new StaleUntilLockStore(path, staleSnapshot)
      const r2 = ingest(raise, ctx(), racing)
      expect(store.readAll().length).toBe(after1) // no double-write
      expect(store.readAll().filter((e) => e.type === 'blocker.opened').length).toBe(1) // exactly ONE blocker
      expect(r2.ids[0]).toBe(firstId) // returns the FIRST's persisted blockerId, never the freshly-minted one
    })
  })
})
