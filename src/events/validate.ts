import { contentHashOf, stripFrame } from './frame.js'
import type { Head } from './head.js'
import type { Sha256, TrackEvent } from './types.js'

export type IntegrityFinding =
  | { kind: 'content-hash'; index: number; eventId: string; expected: Sha256; actual: Sha256 }
  | {
      kind: 'prev-hash'
      index: number
      eventId: string
      expected: Sha256 | null
      actual: Sha256 | null
    }
  | {
      kind: 'aggregate-seq'
      index: number
      eventId: string
      aggregateId: string
      expected: number
      actual: number
    }
  | {
      kind: 'aggregate-mismatch'
      index: number
      eventId: string
      aggregateId: string
      expected: string
      actual: string
    }
  | { kind: 'batch-frame'; index: number; eventId: string; cmdId: string | null; reason: string }
  | { kind: 'partial-batch'; cmdId: string; expected: number; actual: number; reason: string }
  | { kind: 'batch-noncontiguous'; cmdId: string; index: number }
  | { kind: 'truncation'; expected: number; actual: number }
  | { kind: 'head-mismatch'; index: number; expected: Sha256 | null; actual: Sha256 }
  | { kind: 'blocker-scope'; index: number; eventId: string; reason: string }

export interface IntegrityResult {
  ok: boolean
  findings: IntegrityFinding[]
}

/**
 * Integrity check over a stream (SPEC §3, A4 + A5). For each event in stream order:
 * (i) recompute `contentHash` from the core (content tamper), (ii) `prevHash` equals the
 * previous event's stored `contentHash` (insertion/reorder), (iii) per-aggregate `seq` is
 * 1-based and strictly contiguous (drop/dup), (iv) an `aggregateId` keeps one `aggregate`
 * type. Then per `cmdId`: `cmd` iff `cmdId`, a consistent positive integer `n`, every index
 * unique in `[0,n)`, count `== n`, contiguous. With a `head`, suffix **truncation** and
 * head-position tamper are detected.
 *
 * Frozen threat model — NOT detected from the array alone: suffix truncation without a head,
 * a full rewrite-with-rechain, SHA-256 collisions. Durable anchoring is the docs-git layer.
 */
export function validate(
  events: ReadonlyArray<TrackEvent>,
  head?: Head | null,
): IntegrityResult {
  const findings: IntegrityFinding[] = []

  let prevHash: Sha256 | null = null
  const lastSeqByAggregate = new Map<string, number>()
  const aggregateKind = new Map<string, string>()

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!

    // (i) content tamper
    const expectedHash = contentHashOf(stripFrame(e))
    if (e.contentHash !== expectedHash) {
      findings.push({
        kind: 'content-hash',
        index: i,
        eventId: e.id,
        expected: expectedHash,
        actual: e.contentHash,
      })
    }

    // (ii) positional chain (insertion / reorder)
    if (e.prevHash !== prevHash) {
      findings.push({
        kind: 'prev-hash',
        index: i,
        eventId: e.id,
        expected: prevHash,
        actual: e.prevHash,
      })
    }

    // (iii) per-aggregate seq: exact +1, 1-based
    const expectedSeq = (lastSeqByAggregate.get(e.aggregateId) ?? 0) + 1
    if (e.seq !== expectedSeq) {
      findings.push({
        kind: 'aggregate-seq',
        index: i,
        eventId: e.id,
        aggregateId: e.aggregateId,
        expected: expectedSeq,
        actual: e.seq,
      })
    }
    lastSeqByAggregate.set(e.aggregateId, e.seq)

    // (iv) one aggregateId keeps one aggregate type (ULID global uniqueness invariant)
    const knownKind = aggregateKind.get(e.aggregateId)
    if (knownKind === undefined) {
      aggregateKind.set(e.aggregateId, e.aggregate)
    } else if (knownKind !== e.aggregate) {
      findings.push({
        kind: 'aggregate-mismatch',
        index: i,
        eventId: e.id,
        aggregateId: e.aggregateId,
        expected: knownKind,
        actual: e.aggregate,
      })
    }

    // batch frame: cmd iff cmdId
    if (e.cmdId !== undefined && e.cmd === undefined) {
      findings.push({
        kind: 'batch-frame',
        index: i,
        eventId: e.id,
        cmdId: e.cmdId,
        reason: 'cmdId without cmd:{i,n}',
      })
    }
    if (e.cmd !== undefined && e.cmdId === undefined) {
      findings.push({
        kind: 'batch-frame',
        index: i,
        eventId: e.id,
        cmdId: null,
        reason: 'cmd:{i,n} without cmdId',
      })
    }

    prevHash = e.contentHash
  }

  findings.push(...validateBatches(events))
  findings.push(...validateBlockerScope(events))
  findings.push(...validateHead(events, head))

  return { ok: findings.length === 0, findings }
}

/**
 * Lot A fail-closed assertion (the single mitigation for the relaxed `openBlocker` ref check): a
 * dependency `blocker.opened` must satisfy `scope:'extra' ⇒ ref absent ∧ engagementRef present`, and
 * conversely an intra dependency must carry a `ref`. `openBlocker` enforces this at write time, but a
 * self-consistent (valid-hash) event from a future writer / the Lot C bridge / a direct append must NOT
 * fold into a state where the `linked-done`/`linked-accepted` projection dereferences a foreign ref.
 */
function validateBlockerScope(events: ReadonlyArray<TrackEvent>): IntegrityFinding[] {
  const findings: IntegrityFinding[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    if (e.type !== 'blocker.opened') continue
    const p = e.payload as { kind?: unknown; ref?: unknown; scope?: unknown; engagementRef?: unknown; resolutionRule?: unknown }
    let reason: string | undefined
    if (p.kind === 'decision') {
      if (p.ref === undefined) reason = 'decision blocker requires a ref'
    } else if (p.kind === 'dependency') {
      if (p.scope === 'extra') {
        if (p.ref !== undefined) reason = 'extra-scope dependency must not carry a local ref'
        else if (typeof p.engagementRef !== 'string' || p.engagementRef.length === 0)
          reason = 'extra-scope dependency requires a non-empty engagementRef'
        else if (p.resolutionRule !== undefined && p.resolutionRule !== 'manual')
          reason = "extra-scope dependency must resolve 'manual' (track cannot see h2a state)"
      } else if (p.ref === undefined) {
        reason = 'intra-scope dependency requires a ref'
      }
    }
    if (reason !== undefined) findings.push({ kind: 'blocker-scope', index: i, eventId: e.id, reason })
  }
  return findings
}

interface BatchMember {
  index: number
  i: number | undefined
  n: number | undefined
}

function validateBatches(events: ReadonlyArray<TrackEvent>): IntegrityFinding[] {
  const findings: IntegrityFinding[] = []
  const batches = new Map<string, BatchMember[]>()

  events.forEach((e, index) => {
    if (e.cmdId === undefined) return
    const members = batches.get(e.cmdId) ?? []
    members.push({ index, i: e.cmd?.i, n: e.cmd?.n })
    batches.set(e.cmdId, members)
  })

  for (const [cmdId, members] of batches) {
    // Determine a consistent, valid n across members.
    const declaredNs = [...new Set(members.map((m) => m.n).filter((n) => n !== undefined))]
    if (declaredNs.length > 1) {
      findings.push({
        kind: 'partial-batch',
        cmdId,
        expected: -1,
        actual: members.length,
        reason: `inconsistent cmd.n across members: ${declaredNs.join(',')}`,
      })
      continue
    }
    const n = declaredNs[0]
    if (n === undefined || !Number.isInteger(n) || n <= 0) {
      findings.push({
        kind: 'partial-batch',
        cmdId,
        expected: -1,
        actual: members.length,
        reason: `invalid or missing cmd.n (${String(n)})`,
      })
      continue
    }

    // count
    if (members.length !== n) {
      findings.push({
        kind: 'partial-batch',
        cmdId,
        expected: n,
        actual: members.length,
        reason: `expected ${n} members, found ${members.length}`,
      })
    }

    // contiguity in stream
    const indices = members.map((m) => m.index)
    const min = Math.min(...indices)
    const max = Math.max(...indices)
    if (max - min + 1 !== members.length) {
      findings.push({ kind: 'batch-noncontiguous', cmdId, index: min })
    }

    // positions: each i an integer in [0,n), unique, covering 0..n-1
    const seen = new Set<number>()
    for (const m of members) {
      if (m.i === undefined || !Number.isInteger(m.i) || m.i < 0 || m.i >= n) {
        findings.push({
          kind: 'partial-batch',
          cmdId,
          expected: n,
          actual: members.length,
          reason: `invalid cmd.i (${String(m.i)}) for n=${n}`,
        })
        continue
      }
      if (seen.has(m.i)) {
        findings.push({
          kind: 'partial-batch',
          cmdId,
          expected: n,
          actual: members.length,
          reason: `duplicate cmd.i (${m.i})`,
        })
      }
      seen.add(m.i)
    }
    const missing: number[] = []
    for (let p = 0; p < n; p++) {
      if (!seen.has(p)) missing.push(p)
    }
    if (missing.length > 0) {
      findings.push({
        kind: 'partial-batch',
        cmdId,
        expected: n,
        actual: seen.size,
        reason: `missing batch positions ${missing.join(',')}`,
      })
    }
  }

  return findings
}

function validateHead(
  events: ReadonlyArray<TrackEvent>,
  head: Head | null | undefined,
): IntegrityFinding[] {
  if (head === null || head === undefined) return []

  // Suffix truncation: fewer events than the head recorded.
  if (head.streamLength > events.length) {
    return [{ kind: 'truncation', expected: head.streamLength, actual: events.length }]
  }
  // Tamper at the head position. (events.length > head.streamLength is a stale head — rebuildable, not an error.)
  if (head.streamLength >= 1) {
    const anchor = events[head.streamLength - 1]!
    if (anchor.contentHash !== head.lastContentHash) {
      return [
        {
          kind: 'head-mismatch',
          index: head.streamLength - 1,
          expected: head.lastContentHash,
          actual: anchor.contentHash,
        },
      ]
    }
  }
  return []
}
