// Demand lifecycle (Mode A) — the EPHEMERAL lease side-store (DESIGN demand-lifecycle-modeA §Lease).
//
// A `Lease` is an ADVISORY, mutable claim on a subject (a demand or an item) by a handler. It is NOT a
// durable fact: it lives in `.track/leases.json` (a mutable, gitignored side-store — NOT the append-only
// event log; heartbeats must never be events). It NEVER gates an event append (Build 1's appends stand
// alone); it only records WHO is currently handling a subject so reads can surface a `currentHandler`.
//
// One ACTIVE lease per subject. Steal-safety mirrors `withFileLock`'s generation discipline: each
// acquisition mints a fresh, unguessable `token`; only the holder presenting the matching token may
// heartbeat or release (a wrong token is rejected). The store is serialized under its OWN file-lock
// (reuse `withFileLock` on the leases path) so two processes never corrupt the JSON.
//
// ABANDONMENT IS CLOCKLESS, COMPUTED BY THE READER (the caller injects `now`): a lease is abandoned iff
// `now − heartbeatAt > ttlMs`. The store itself holds NO clock for abandonment decisions — it only stamps
// `acquiredAt`/`heartbeatAt`/`expiresAt` from the caller-injected clock at write time (so tests are
// deterministic and the store stays pure/host-portable, like the rest of track).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

import { withFileLock } from '../events/lock.js'
import { DomainError } from '../model/item.js'
import type { ActorId, Sha256 } from '../events/types.js'

/** Default lease TTL (owner-tunable). 30 min — long enough for a real spec/qualify attempt, short enough
 *  that a dead agent's claim frees the subject within one working bout (DESIGN §Owner micro-decisions). */
export const DEFAULT_LEASE_TTL_MS = 30 * 60_000 // 30 minutes

/** The work-phase a lease covers (the lifecycle stage the holder is actively driving). */
export type LeasePhase = 'qualifying' | 'specifying' | 'executing'

/** The subject a lease is held on — a demand (qualifying) or an item (specifying/executing). */
export interface LeaseSubject {
  kind: 'demand' | 'item'
  id: string
}

/**
 * An ephemeral, advisory lease on a subject (DESIGN §Lease). PERSISTED VERBATIM in `.track/leases.json`.
 * `acquiredAt`/`heartbeatAt`/`expiresAt` are ISO-8601 (caller-injected clock). `token` is the per-
 * acquisition steal-guard. `eventHeadAtAcquire` snapshots the log tail at acquire (audit: which log state
 * the holder claimed against). Abandonment is NOT a stored field — it is computed by the reader vs `now`.
 */
export interface Lease {
  leaseId: string
  workspace: string
  subject: LeaseSubject
  phase: LeasePhase
  holder: ActorId
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
  ttlMs: number
  token: string
  eventHeadAtAcquire?: Sha256
}

/** Stable per-subject key (kind + id) — one ACTIVE lease per subject is keyed on this. */
function subjectKey(subject: LeaseSubject): string {
  return `${subject.kind}:${subject.id}`
}

/**
 * Is `lease` abandoned at `now`? PURE/CLOCKLESS: the caller injects `now`; abandoned iff
 * `now − heartbeatAt > ttlMs`. The single abandonment predicate — reused by the store's acquire guard
 * (a stale lease does NOT block a fresh acquire) AND by the reader's `leaseState`/stalled projection.
 */
export function isLeaseAbandoned(lease: Lease, now: string): boolean {
  return Date.parse(now) - Date.parse(lease.heartbeatAt) > lease.ttlMs
}

/**
 * The ephemeral lease side-store. Reads/writes `.track/leases.json` under `withFileLock` (its OWN lock,
 * never the event-log lock — the two are independent). `now`/`newId` are injectable (deterministic tests;
 * the store stamps `acquiredAt`/`heartbeatAt`/`expiresAt` from the injected clock, but holds NO clock for
 * abandonment — that is the reader's call).
 */
export class LeaseStore {
  private readonly clock: () => string
  private readonly newId: () => string

  constructor(
    private readonly leasesPath: string,
    opts: { now?: () => string; newId?: () => string } = {},
  ) {
    this.clock = opts.now ?? (() => new Date().toISOString())
    this.newId = opts.newId ?? (() => randomBytes(12).toString('hex'))
  }

  /** Read all leases (every recorded lease, abandoned or live — the reader decides liveness vs `now`). */
  readAll(): Lease[] {
    return readLeasesFile(this.leasesPath)
  }

  /** The lease (if any) currently RECORDED for a subject (live OR abandoned — caller decides vs `now`). */
  forSubject(subject: LeaseSubject): Lease | undefined {
    const key = subjectKey(subject)
    return this.readAll().find((l) => subjectKey(l.subject) === key)
  }

  /**
   * Acquire a lease on a subject. Rejects (DomainError) if a LIVE lease already covers it — one active
   * lease per subject. An ABANDONED prior lease (per `now − heartbeatAt > ttlMs`) does NOT block: the new
   * acquisition replaces it (steal-safe — the new holder mints a FRESH token, so the dead holder's stale
   * token can never heartbeat/release the new lease). Mints `leaseId` + a fresh `token`. Returns the lease.
   */
  acquire(input: {
    workspace: string
    subject: LeaseSubject
    phase: LeasePhase
    holder: ActorId
    ttlMs?: number
    eventHeadAtAcquire?: Sha256
  }): Lease {
    return withFileLock(this.leasesPath, () => {
      const all = readLeasesFile(this.leasesPath)
      const key = subjectKey(input.subject)
      const now = this.clock()
      const existing = all.find((l) => subjectKey(l.subject) === key)
      if (existing !== undefined && !isLeaseAbandoned(existing, now)) {
        throw new DomainError(
          `lease: subject ${key} is already held by ${existing.holder} (one active lease per subject)`,
        )
      }
      const ttlMs = input.ttlMs ?? DEFAULT_LEASE_TTL_MS
      const lease: Lease = {
        leaseId: this.newId(),
        workspace: input.workspace,
        subject: input.subject,
        phase: input.phase,
        holder: input.holder,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
        ttlMs,
        token: this.newId(),
        ...(input.eventHeadAtAcquire !== undefined ? { eventHeadAtAcquire: input.eventHeadAtAcquire } : {}),
      }
      // Replace any prior (abandoned) lease for this subject; keep all OTHER subjects' leases.
      const next = all.filter((l) => subjectKey(l.subject) !== key)
      next.push(lease)
      writeLeasesFile(this.leasesPath, next)
      return lease
    })
  }

  /**
   * Heartbeat (renew) a lease — ONLY the holder may, and ONLY with the matching `token` (steal-safe). The
   * token must match the recorded acquisition; a wrong/stale token is rejected (DomainError). Renews
   * `heartbeatAt` (and re-derives `expiresAt`) from the injected clock; the reader's abandonment window
   * resets. Rejects if no lease is recorded for the subject. Returns the renewed lease.
   */
  heartbeat(input: { subject: LeaseSubject; token: string }): Lease {
    return withFileLock(this.leasesPath, () => {
      const all = readLeasesFile(this.leasesPath)
      const key = subjectKey(input.subject)
      const idx = all.findIndex((l) => subjectKey(l.subject) === key)
      if (idx === -1) throw new DomainError(`lease: no lease to heartbeat for subject ${key}`)
      const lease = all[idx]!
      if (lease.token !== input.token) {
        throw new DomainError(`lease: heartbeat token mismatch for subject ${key} — only the holder may renew`)
      }
      const now = this.clock()
      const renewed: Lease = {
        ...lease,
        heartbeatAt: now,
        expiresAt: new Date(Date.parse(now) + lease.ttlMs).toISOString(),
      }
      all[idx] = renewed
      writeLeasesFile(this.leasesPath, all)
      return renewed
    })
  }

  /**
   * Release a lease — ONLY the holder may, and ONLY with the matching `token` (steal-safe). The token must
   * match; a wrong/stale token is rejected (DomainError). Removes the lease entirely (the subject is now
   * unheld). Rejects if no lease is recorded for the subject.
   */
  release(input: { subject: LeaseSubject; token: string }): void {
    withFileLock(this.leasesPath, () => {
      const all = readLeasesFile(this.leasesPath)
      const key = subjectKey(input.subject)
      const idx = all.findIndex((l) => subjectKey(l.subject) === key)
      if (idx === -1) throw new DomainError(`lease: no lease to release for subject ${key}`)
      if (all[idx]!.token !== input.token) {
        throw new DomainError(`lease: release token mismatch for subject ${key} — only the holder may release`)
      }
      all.splice(idx, 1)
      writeLeasesFile(this.leasesPath, all)
    })
  }
}

/** Resolve the leases side-store path that sits beside an `events.jsonl` (`.track/leases.json`). */
export function leasesPathFor(eventsPath: string): string {
  return join(dirname(eventsPath), 'leases.json')
}

/** Read + parse the leases file. A missing/empty/torn file fails CLOSED to `[]` (no leases ⇒ no holder). */
function readLeasesFile(leasesPath: string): Lease[] {
  if (!existsSync(leasesPath)) return []
  try {
    const raw = readFileSync(leasesPath, 'utf8').trim()
    if (raw === '') return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as Lease[]) : []
  } catch {
    return [] // a torn/garbled side-store is advisory-only — degrade to "no leases", never throw a read
  }
}

/** Serialize the leases file (pretty for human/audit grep; the side-store is small + mutable). */
function writeLeasesFile(leasesPath: string, leases: Lease[]): void {
  writeFileSync(leasesPath, `${JSON.stringify(leases, null, 2)}\n`)
}
