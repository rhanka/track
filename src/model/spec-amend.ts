// M5 (canevas) — `item.spec-amend` → `spec.amended`: a net-new, owner-approved, ADDITIVE write kind
// for LIVE spec amendment with a human/machine diff trace. It is the concurrent-safe live-amendment
// primitive (the coarse `decision.dossier` whole-rewrite is a lost-update hazard; this is a per-patch,
// append-only record). RECORD-ONLY: track records the JsonPatch VERBATIM and NEVER applies/validates the
// patch semantics — `baseHash`/`resultHash` are OPAQUE integrity tags (the spec document lives in the
// host's LiveDocument). The amendment TRACE is the value; track destroys no spec field.

import { DomainError, type ItemId } from './item.js'

/**
 * An RFC-6902-shaped JSON Patch, recorded VERBATIM. track does NOT apply it, does NOT validate `op`
 * against the document, and does NOT recompute `baseHash`→`resultHash`. It is an opaque, hash-covered
 * payload member: a tampered patch changes the recorded amendment, which is exactly the audit value.
 */
export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test'
  path: string
  value?: unknown
  from?: string
}
export type JsonPatch = JsonPatchOp[]

/** The `item.spec-amend` payload / `spec.amended` event payload (M5 canevas §3). */
export interface SpecAmendPayload {
  itemId: ItemId
  /** The decision dossier this amendment was negotiated under (optional). */
  decisionId?: ItemId
  /** A pointer to the host LiveDocument the patch targets (optional). */
  liveDocRef?: string
  /** Opaque hash of the spec document BEFORE the patch (integrity tag; never recomputed). */
  baseHash: string
  /** The JsonPatch, recorded verbatim (track never applies it). */
  patch: JsonPatch
  /** Opaque hash of the spec document AFTER the patch (integrity tag; never recomputed). */
  resultHash: string
  /**
   * A reference to an AI proposal this amendment accepts/derives from. When a human/signed amend carries
   * a `proposalRef`, it records ACCEPTANCE of that proposal WITHOUT laundering the machine origin: BOTH
   * the machine-proposed amend (prov.proposed:true) and the human acceptance stay in the trace.
   */
  proposalRef?: string
  summary?: string
}

/**
 * One materialized amendment in `state.specAmendments[itemId]` — record-only, in stream order. `at`/`by`
 * come from the event frame (not the payload). The full prov-tagged ordering is reconstructed by the read
 * surface (`TrackReader.amendmentTrace`) directly over the log; this projection is the per-item record.
 */
export interface SpecAmendment {
  itemId: ItemId
  baseHash: string
  patch: JsonPatch
  resultHash: string
  at: string
  decisionId?: ItemId
  liveDocRef?: string
  proposalRef?: string
  summary?: string
}

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * Fail-closed validation + normalization of a `SpecAmendPayload` (mirrors `assertVerificationRun`/
 * `assertScopeDecl`). Requires `itemId`/`baseHash`/`resultHash`/`patch`; the patch must be an array of
 * `{op:string, path:string, …}` objects (shape only — track NEVER interprets the patch). Drops absent
 * optionals so the recorded shape is minimal + hash-stable. The `itemId` legality (exists, is an item)
 * is checked by the facade against folded state; this is the pure shape gate.
 */
export function assertSpecAmend(input: unknown): SpecAmendPayload {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DomainError('item.spec-amend: an amendment must be an object')
  }
  const a = input as Record<string, unknown>
  if (!nonEmptyString(a['itemId'])) throw new DomainError('item.spec-amend: requires an itemId')
  if (!nonEmptyString(a['baseHash'])) throw new DomainError('item.spec-amend: requires a baseHash')
  if (!nonEmptyString(a['resultHash'])) throw new DomainError('item.spec-amend: requires a resultHash')
  if (!Array.isArray(a['patch'])) throw new DomainError('item.spec-amend: patch must be a JsonPatch array')
  const patch: JsonPatch = a['patch'].map((op, i) => {
    if (typeof op !== 'object' || op === null || Array.isArray(op)) {
      throw new DomainError(`item.spec-amend: patch[${i}] must be an object`)
    }
    const o = op as Record<string, unknown>
    if (!nonEmptyString(o['op'])) throw new DomainError(`item.spec-amend: patch[${i}].op is required`)
    if (typeof o['path'] !== 'string') throw new DomainError(`item.spec-amend: patch[${i}].path must be a string`)
    return o as unknown as JsonPatchOp // recorded VERBATIM (track never interprets the op)
  })
  for (const key of ['decisionId', 'liveDocRef', 'proposalRef', 'summary'] as const) {
    if (a[key] !== undefined && typeof a[key] !== 'string') {
      throw new DomainError(`item.spec-amend: ${key} must be a string`)
    }
  }
  return {
    itemId: a['itemId'],
    baseHash: a['baseHash'],
    patch,
    resultHash: a['resultHash'],
    ...(a['decisionId'] !== undefined ? { decisionId: a['decisionId'] as ItemId } : {}),
    ...(a['liveDocRef'] !== undefined ? { liveDocRef: a['liveDocRef'] as string } : {}),
    ...(a['proposalRef'] !== undefined ? { proposalRef: a['proposalRef'] as string } : {}),
    ...(a['summary'] !== undefined ? { summary: a['summary'] as string } : {}),
  }
}
