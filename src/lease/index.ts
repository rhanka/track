// Demand lifecycle (Mode A, Build 2) — the ephemeral lease side-store barrel. The PRODUCER surface (h2a or
// any actor mints/heartbeats/releases claims) + the pure abandonment predicate the READER reuses. The lease
// is advisory: it NEVER gates an event append (Build 1's appends stand alone).
export {
  DEFAULT_LEASE_TTL_MS,
  LeaseStore,
  isLeaseAbandoned,
  leasesPathFor,
  type Lease,
  type LeasePhase,
  type LeaseSubject,
} from './store.js'
