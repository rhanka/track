// Scope §B(c) — the path-verdict sibling of TestRun (acceptance.run). A `VerificationRun` is the
// EVIDENCE a harness emits after checking a tree against scope path-globs. It is RECORD-ONLY: track
// NEVER does glob-matching — the offending paths in `violations` are recorded VERBATIM as opaque
// locators, never re-matched. A path verdict can NEVER spawn/advance/complete a TODO (structural
// guarantee: fold appends to its own evidence collection, touching no realization/bucket logic).

import { DomainError, type ItemId } from './item.js'

/** The path verdict a harness computed. `severity→pass/fail` is the adapter's policy, not the contract. */
export type Verdict = 'clean' | 'violation' | 'conditional'
export const VERDICTS: readonly Verdict[] = ['clean', 'violation', 'conditional']

/**
 * A recorded path-scope verification (the sibling of {@link TestRun}). Evidence-only: it surfaces on
 * the read contract for a future `scope validate` to read, but is INERT to bucketing/realization.
 */
export interface VerificationRun {
  runId: string
  runner: string
  commit: string
  env?: string
  verdict: Verdict
  /** The WP/phase the verdict pertains to; absent ⇒ a workspace-scoped run. */
  wpRef?: ItemId
  /** Offending paths, recorded VERBATIM (opaque locators) — track NEVER re-matches them. */
  violations?: string[]
  at: string
}

/** The payload of a `scope.verification` WorkEvent / `scope.verification-recorded` event. */
export interface VerificationRecordedPayload {
  runId: string
  runner: string
  commit: string
  env?: string
  verdict: Verdict
  wpRef?: ItemId
  violations?: string[]
}

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * Fail-closed validation of a VerificationRun payload (mirrors `assertDossierArtifact`). The envelope
 * schema only checks the flat fields (`runId`/`runner`/`commit`/`verdict` present, `env`/`wpRef`
 * strings, `violations` a string[]); this asserts the verdict enum + that `violations` are all strings,
 * and normalizes (drops absent optionals so the recorded shape is minimal + hash-stable).
 */
export function assertVerificationRun(input: unknown): VerificationRecordedPayload {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DomainError('scope.verification: a verification run must be an object')
  }
  const a = input as Record<string, unknown>
  if (!nonEmptyString(a['runId'])) throw new DomainError('scope.verification: requires a runId')
  if (!nonEmptyString(a['runner'])) throw new DomainError('scope.verification: requires a runner')
  if (!nonEmptyString(a['commit'])) throw new DomainError('scope.verification: requires a commit')
  if (typeof a['verdict'] !== 'string' || !VERDICTS.includes(a['verdict'] as Verdict)) {
    throw new DomainError(`scope.verification: verdict must be one of ${VERDICTS.join('|')}`)
  }
  if (a['env'] !== undefined && typeof a['env'] !== 'string') {
    throw new DomainError('scope.verification: env must be a string')
  }
  if (a['wpRef'] !== undefined && !nonEmptyString(a['wpRef'])) {
    throw new DomainError('scope.verification: wpRef must be a non-empty item id')
  }
  let violations: string[] | undefined
  if (a['violations'] !== undefined) {
    if (!Array.isArray(a['violations']) || !a['violations'].every((v) => typeof v === 'string')) {
      throw new DomainError('scope.verification: violations must be a string[]')
    }
    violations = a['violations'] as string[]
  }
  return {
    runId: a['runId'],
    runner: a['runner'],
    commit: a['commit'],
    verdict: a['verdict'] as Verdict,
    ...(a['env'] !== undefined ? { env: a['env'] as string } : {}),
    ...(a['wpRef'] !== undefined ? { wpRef: a['wpRef'] as ItemId } : {}),
    ...(violations !== undefined ? { violations } : {}),
  }
}
