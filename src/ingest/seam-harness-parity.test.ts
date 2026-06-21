// BR-H1 cross-contract DRIFT-GATE — track's agreement-mirror `$defs` ↔ the harness producer-internal
// `VerificationRun` schema (PR #343, vendored under __fixtures__). The atomic-pair discipline: a drift on
// EITHER side fails a gate. Track's half pins the mirror against the vendored harness golden so the two
// repos agree on the frozen v0 shape without either importing the other's runtime.
//
// PIN-CORRECTION (load-bearing — see docs/reviews/brh1-cross-snapshot-SYNTHESIS.md §"Pin-correction"):
// the two schemas are at DIFFERENT LAYERS, not one artifact at two dialects.
//   - harness ROOT          = the producer-internal VerificationRun (PRE-projection: run + checks + targets).
//   - track SEAM_V0_SCHEMA  = the WorkEvent WIRE envelope (POST-projection: scope.verification /
//                             acceptance.run / acceptance.link), PLUS an embedded agreement-MIRROR
//                             `$defs.{VerificationRun, VerificationCheck, VerificationTarget, Violation}`.
// ⇒ This gate pins **harness root + harness `definitions` ↔ track's mirror `$defs` + shared enum `$defs`**
// via NORMALIZED projections ONLY (enum arrays, required arrays, property-name sets) — NEVER a
// whole-document `toEqual`, and NEVER against the wire-projection payloads (ScopeVerificationPayload …).
// The dialect (harness draft-07 vs track 2020-12) is metadata-only — we never assert on `$schema`.
//
// NO network, NO `@sentropic/harness` devDependency, deterministic: the harness side is the VENDORED
// fixture (its SHA-256 is pinned below, so an unreviewed fixture change fails the suite).

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { SEAM_V0_SCHEMA } from './seam-schema.js'

// --- vendored harness fixture (read-only copy of @sentropic/harness@0.3.0, PR #343) ------------------
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = join(HERE, '__fixtures__', 'harness-verification-run.schema.json')
const FIXTURE_BYTES = readFileSync(FIXTURE_PATH)
const HARNESS = JSON.parse(FIXTURE_BYTES.toString('utf8')) as HarnessSchema

// Pinned digest of the vendored fixture. An unreviewed edit changes the bytes ⇒ this fails ⇒ the
// intentional harness update must land as a REVIEWED fixture diff (re-pin this constant in the same PR).
const EXPECTED_HARNESS_FIXTURE_SHA256 = '854be4e46e593ea2bc8d0b24e1d52ccc313dd547388272633ef52380b0a0fcbb'

// Minimal structural typing of the harness draft-07 document (it nests under `definitions`, not `$defs`).
interface JsonSchemaNode {
  enum?: readonly string[]
  required?: readonly string[]
  minProperties?: number
  properties?: Record<string, JsonSchemaNode>
  $ref?: string
}
interface HarnessSchema extends JsonSchemaNode {
  definitions: {
    VerificationCategory: JsonSchemaNode
    ViolationSeverity: JsonSchemaNode
    Violation: JsonSchemaNode
    VerificationTarget: JsonSchemaNode
    VerificationCheck: JsonSchemaNode
  }
}

const sorted = (xs: readonly string[] | undefined): string[] => [...(xs ?? [])].sort()
// `node` is read structurally from BOTH the harness fixture (loosely typed) and the deeply-typed
// `as const` mirror `$defs` — so accept `unknown` and reach `.properties` defensively (the literal
// mirror nodes don't structurally satisfy a hand-written JsonSchemaNode, but their `properties` key
// is always an object of named sub-schemas, which is all this projection reads).
const props = (node: unknown): string[] =>
  Object.keys((node as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}).sort()

describe('BR-H1 fixture provenance pin', () => {
  it('the vendored harness fixture matches its reviewed SHA-256 (an unreviewed edit fails here)', () => {
    const digest = createHash('sha256').update(FIXTURE_BYTES).digest('hex')
    expect(digest).toBe(EXPECTED_HARNESS_FIXTURE_SHA256)
  })

  it('the fixture is the producer-internal VerificationRun (root checks, nested definitions)', () => {
    // Sanity: confirms we vendored the PRE-projection artifact (a `definitions`-nested draft-07 doc with a
    // `checks` array at the root), NOT a wire-projection payload — so the layer-pairing below is correct.
    expect(props(HARNESS)).toContain('checks')
    expect(HARNESS.definitions.VerificationCheck).toBeDefined()
  })
})

describe('BR-H1 drift-gate — frozen ENUM equality (harness ↔ track mirror)', () => {
  it('severity = [advisory, blocking] on both', () => {
    expect(sorted(HARNESS.definitions.ViolationSeverity.enum)).toEqual(['advisory', 'blocking'])
    expect(sorted(SEAM_V0_SCHEMA.$defs.Severity.enum)).toEqual(['advisory', 'blocking'])
  })

  it('acceptance.run result = [fail, pass] on both', () => {
    expect(sorted(HARNESS.properties?.['result']?.enum)).toEqual(['fail', 'pass'])
    expect(sorted(SEAM_V0_SCHEMA.$defs.RunResult.enum)).toEqual(['fail', 'pass'])
  })

  it('evidence-kind = [e2e, integration, manual, unit] on both', () => {
    const harnessKind = HARNESS.definitions.VerificationTarget.properties?.['acceptance']?.properties?.['kind']
    expect(sorted(harnessKind?.enum)).toEqual(['e2e', 'integration', 'manual', 'unit'])
    expect(sorted(SEAM_V0_SCHEMA.$defs.EvidenceKind.enum)).toEqual(['e2e', 'integration', 'manual', 'unit'])
  })

  it('schemaVersion/v const = 1 on both (harness schemaVersion:1, track envelope v:1)', () => {
    expect((HARNESS.properties?.['schemaVersion'] as { const?: number } | undefined)?.const).toBe(1)
    expect((SEAM_V0_SCHEMA.properties.v as { const?: number }).const).toBe(1)
  })
})

describe('BR-H1 drift-gate — VerificationCategory: security MEMBERSHIP only (D3, NOT enum-equality)', () => {
  // D3: the two category enums are DIFFERENT DOMAINS (harness 8-value verify-taxonomy vs track 3-value
  // routing enum). They share only the reserved `security` slot. Assert MEMBERSHIP on both — NEVER
  // enum-equality (that would be a broken gate equating two unrelated enums).
  it('`security` is reserved on BOTH VerificationCategory enums', () => {
    expect(HARNESS.definitions.VerificationCategory.enum).toContain('security')
    expect(SEAM_V0_SCHEMA.$defs.VerificationCategory.enum).toContain('security')
  })
})

describe('BR-H1 drift-gate — VerificationTarget sub-shape (harness ↔ track mirror)', () => {
  const harnessTarget = HARNESS.definitions.VerificationTarget
  const mirrorTarget = SEAM_V0_SCHEMA.$defs.VerificationCheck.properties.target

  it('minProperties:1 (≥1 of scope|acceptance) on both', () => {
    expect(harnessTarget.minProperties).toBe(1)
    expect(mirrorTarget.minProperties).toBe(1)
  })

  it('scope.required = [wpRef] on both', () => {
    expect(sorted(harnessTarget.properties?.['scope']?.required)).toEqual(['wpRef'])
    expect(sorted(mirrorTarget.properties.scope.required)).toEqual(['wpRef'])
  })

  it('acceptance.required = [evidenceId, kind] (sorted) on both', () => {
    expect(sorted(harnessTarget.properties?.['acceptance']?.required)).toEqual(['evidenceId', 'kind'])
    expect(sorted(mirrorTarget.properties.acceptance.required)).toEqual(['evidenceId', 'kind'])
  })

  it('acceptance property-set = [criterionIds, evidenceId, kind] on both', () => {
    expect(props(harnessTarget.properties?.['acceptance'])).toEqual(['criterionIds', 'evidenceId', 'kind'])
    expect(props(mirrorTarget.properties.acceptance)).toEqual(['criterionIds', 'evidenceId', 'kind'])
  })
})

describe('BR-H1 drift-gate — artifactLocator REQUIRED at run level (harness ↔ track mirror)', () => {
  it('artifactLocator is in the required[] of harness root AND the mirror VerificationRun', () => {
    expect(HARNESS.required).toContain('artifactLocator')
    expect(SEAM_V0_SCHEMA.$defs.VerificationRun.required).toContain('artifactLocator')
  })
})

describe('BR-H1 drift-gate — D1: per-check target is OPTIONAL on both', () => {
  // D1 (ratified): harness leaves `target` OFF VerificationCheck.required (fail-closed-no-target is an
  // ADAPTER behavior, OQ-2). Track's mirror is RELAXED to match — `target` dropped from required. Pin both.
  it('harness VerificationCheck does NOT require target', () => {
    expect(HARNESS.definitions.VerificationCheck.required).not.toContain('target')
  })

  it('track mirror VerificationCheck does NOT require target (D1 relaxation)', () => {
    expect(SEAM_V0_SCHEMA.$defs.VerificationCheck.required).not.toContain('target')
  })

  it('target STILL EXISTS as an optional property on the mirror (relaxed required, shape kept)', () => {
    expect(SEAM_V0_SCHEMA.$defs.VerificationCheck.properties.target).toBeDefined()
  })
})

describe('BR-H1 drift-gate — D2: Violation.path is OPTIONAL on both', () => {
  // D2 (ratified): a path-less violation is valid; `path` is optional on both. The canonical
  // stringify-projection rule (OMIT a missing path — never empty-string fill) is DOCUMENTED on the mirror
  // `$defs.Violation`; track does not perform that stringify yet (the full VerificationRun→violations[]
  // adapter is a later lot), so the OMIT rule is documentation-only for this lot.
  it('harness Violation does NOT require path', () => {
    expect(HARNESS.definitions.Violation.required).not.toContain('path')
  })

  it('track mirror Violation does NOT require path (D2 relaxation)', () => {
    expect(SEAM_V0_SCHEMA.$defs.Violation.required).not.toContain('path')
  })

  it('path STILL EXISTS as an optional property on the mirror (relaxed required, shape kept)', () => {
    expect(SEAM_V0_SCHEMA.$defs.Violation.properties.path).toBeDefined()
  })

  it('the surviving Violation required fields match harness ([code, message, severity], sorted)', () => {
    expect(sorted(HARNESS.definitions.Violation.required)).toEqual(['code', 'message', 'severity'])
    expect(sorted(SEAM_V0_SCHEMA.$defs.Violation.required)).toEqual(['code', 'message', 'severity'])
  })
})
