import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_LEASE_TTL_MS, LeaseStore, isLeaseAbandoned, leasesPathFor } from './store.js'

// The ephemeral lease side-store (DESIGN demand-lifecycle-modeA §Lease). PURE/clockless abandonment is the
// READER's call (`now − heartbeatAt > ttlMs`); the store stamps timestamps from an injected clock so these
// tests are deterministic. Steal-safety = a per-acquisition `token` (only the holder/token may heartbeat/
// release). One ACTIVE lease per subject.

const NOW = '2026-06-21T10:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const DEMAND = { kind: 'demand' as const, id: 'demand-1' }
const ITEM = { kind: 'item' as const, id: 'item-1' }

let dir: string
let leasesPath: string

/** A LeaseStore stamping every write `at = when`, with deterministic ids (`lease-N` / `token-N`). */
function storeAt(when: string): LeaseStore {
  let n = 0
  return new LeaseStore(leasesPath, { now: () => when, newId: () => `gen-${String(++n).padStart(4, '0')}` })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-lease-'))
  leasesPath = join(dir, '.track', 'leases.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('leasesPathFor — sits beside events.jsonl', () => {
  it('derives .track/leases.json from .track/events.jsonl', () => {
    expect(leasesPathFor(join(dir, '.track', 'events.jsonl'))).toBe(join(dir, '.track', 'leases.json'))
  })
})

describe('acquire — mints a lease, one active lease per subject', () => {
  it('acquires a fresh lease with a leaseId + token + stamped timestamps', () => {
    const lease = storeAt(NOW).acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h:alice' })
    expect(lease).toMatchObject({
      workspace: 'W',
      subject: DEMAND,
      phase: 'qualifying',
      holder: 'h:alice',
      acquiredAt: NOW,
      heartbeatAt: NOW,
      ttlMs: DEFAULT_LEASE_TTL_MS,
    })
    expect(lease.leaseId).toBeTruthy()
    expect(lease.token).toBeTruthy()
    expect(lease.leaseId).not.toBe(lease.token) // distinct generations
    expect(Date.parse(lease.expiresAt)).toBe(NOW_MS + DEFAULT_LEASE_TTL_MS)
  })

  it('persists to .track/leases.json (the side-store, beside the log)', () => {
    storeAt(NOW).acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h:alice' })
    expect(existsSync(leasesPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(leasesPath, 'utf8')) as Array<{ holder: string }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.holder).toBe('h:alice')
  })

  it('rejects a second acquire on the same LIVE subject (one active lease per subject)', () => {
    const store = storeAt(NOW)
    store.acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h:alice' })
    expect(() => store.acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h:bob' })).toThrow(
      /already held/,
    )
  })

  it('allows acquiring DIFFERENT subjects concurrently (the guard is per-subject)', () => {
    const store = storeAt(NOW)
    store.acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h:alice' })
    expect(() => store.acquire({ workspace: 'W', subject: ITEM, phase: 'specifying', holder: 'h:bob' })).not.toThrow()
    expect(store.readAll()).toHaveLength(2)
  })

  it('records eventHeadAtAcquire when supplied (drop-when-absent otherwise)', () => {
    const store = storeAt(NOW)
    const withHead = store.acquire({
      workspace: 'W',
      subject: DEMAND,
      phase: 'qualifying',
      holder: 'h',
      eventHeadAtAcquire: 'sha256:abc',
    })
    expect(withHead.eventHeadAtAcquire).toBe('sha256:abc')
    const withoutHead = store.acquire({ workspace: 'W', subject: ITEM, phase: 'specifying', holder: 'h' })
    expect('eventHeadAtAcquire' in withoutHead).toBe(false)
  })

  it('honors a caller-supplied ttlMs', () => {
    const lease = storeAt(NOW).acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h', ttlMs: 5_000 })
    expect(lease.ttlMs).toBe(5_000)
    expect(Date.parse(lease.expiresAt)).toBe(NOW_MS + 5_000)
  })
})

describe('heartbeat — only the holder/token may renew (steal-safe)', () => {
  it('renews heartbeatAt + expiresAt for the matching token', () => {
    const acq = storeAt(NOW).acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h' })
    const later = new Date(NOW_MS + 60_000).toISOString()
    const renewed = storeAt(later).heartbeat({ subject: DEMAND, token: acq.token })
    expect(renewed.heartbeatAt).toBe(later)
    expect(Date.parse(renewed.expiresAt)).toBe(Date.parse(later) + DEFAULT_LEASE_TTL_MS)
    expect(renewed.acquiredAt).toBe(NOW) // acquiredAt is immutable
    expect(renewed.leaseId).toBe(acq.leaseId) // same lease
  })

  it('REJECTS a heartbeat with a wrong token (a thief cannot renew)', () => {
    storeAt(NOW).acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h' })
    expect(() => storeAt(NOW).heartbeat({ subject: DEMAND, token: 'wrong-token' })).toThrow(/token mismatch/)
  })

  it('rejects a heartbeat on an unheld subject', () => {
    expect(() => storeAt(NOW).heartbeat({ subject: DEMAND, token: 't' })).toThrow(/no lease to heartbeat/)
  })
})

describe('release — only the holder/token may release (steal-safe)', () => {
  it('removes the lease for the matching token', () => {
    const acq = storeAt(NOW).acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h' })
    storeAt(NOW).release({ subject: DEMAND, token: acq.token })
    expect(storeAt(NOW).forSubject(DEMAND)).toBeUndefined()
  })

  it('REJECTS a release with a wrong token (a thief cannot release)', () => {
    storeAt(NOW).acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h' })
    expect(() => storeAt(NOW).release({ subject: DEMAND, token: 'wrong' })).toThrow(/token mismatch/)
    expect(storeAt(NOW).forSubject(DEMAND)).toBeDefined() // still held
  })

  it('after release the subject is re-acquirable by anyone', () => {
    const acq = storeAt(NOW).acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h:alice' })
    storeAt(NOW).release({ subject: DEMAND, token: acq.token })
    expect(() =>
      storeAt(NOW).acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h:bob' }),
    ).not.toThrow()
  })
})

describe('isLeaseAbandoned — clockless, computed vs an injected now', () => {
  it('live while now − heartbeatAt ≤ ttlMs; abandoned once it exceeds ttlMs', () => {
    const lease = storeAt(NOW).acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h', ttlMs: 1_000 })
    expect(isLeaseAbandoned(lease, new Date(NOW_MS + 1_000).toISOString())).toBe(false) // exactly ttl ⇒ not yet
    expect(isLeaseAbandoned(lease, new Date(NOW_MS + 1_001).toISOString())).toBe(true) // strictly past ⇒ abandoned
  })
})

describe('acquire over an ABANDONED prior lease — steal-safe replacement', () => {
  it('a NEW holder may acquire when the prior lease is abandoned (and the OLD token can no longer act)', () => {
    // One shared id counter across both stores so generations are globally unique (real `newId` is random).
    let n = 0
    const at = (when: string): LeaseStore =>
      new LeaseStore(leasesPath, { now: () => when, newId: () => `gen-${String(++n).padStart(4, '0')}` })
    const old = at(NOW).acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h:dead', ttlMs: 1_000 })
    const past = new Date(NOW_MS + 10_000).toISOString() // well past the 1s ttl ⇒ abandoned
    const fresh = at(past).acquire({ workspace: 'W', subject: DEMAND, phase: 'qualifying', holder: 'h:live' })
    expect(fresh.holder).toBe('h:live')
    expect(fresh.token).not.toBe(old.token) // a fresh generation
    expect(at(past).readAll()).toHaveLength(1) // the abandoned lease was REPLACED, not duplicated
    // the dead holder's stale token can neither heartbeat nor release the new lease
    expect(() => at(past).heartbeat({ subject: DEMAND, token: old.token })).toThrow(/token mismatch/)
    expect(() => at(past).release({ subject: DEMAND, token: old.token })).toThrow(/token mismatch/)
  })
})
