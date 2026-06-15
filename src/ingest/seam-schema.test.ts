// Contract-SNAPSHOT gate for the harness↔track seam v0 JSON-Schema artifact (BR-H1 contract-snapshots
// against THIS). A drift in the published schema (a renamed/removed kind, payload field, or enum value)
// MUST fail here — both sides (harness + track) pin the same golden. Inline golden (the repo convention;
// no vitest file-snapshots), so the schema diff is reviewable in the PR.
//
// Three layers of gate:
//   1. the inline golden (a schema-vs-schema drift fails);
//   2. a STRUCTURAL gate proving the artifact is a REAL Draft-2020-12 schema (root envelope + a kind
//      dispatch + minLength on the non-empty strings — NOT a bare {type:object} payload under a custom
//      key a validator would ignore);
//   3. a WIRE-PARITY drift-gate deriving the {required, optional} field sets from WORK_EVENT_SCHEMA and
//      asserting they equal the seam payload subschemas — so a WORK_EVENT_SCHEMA change NOT mirrored in
//      the seam schema FAILS the suite (a true drift-gate, not a self-snapshot).

import { describe, expect, it } from 'vitest'

import { WORK_EVENT_SCHEMA, type WorkEventKind } from './contract.js'
import { SEAM_V0_PAYLOAD_DEFS, SEAM_V0_SCHEMA, SEAM_V0_SCHEMA_VERSION } from './seam-schema.js'

describe('seam v0 JSON-Schema artifact (contract-snapshot)', () => {
  it('pins the schema version', () => {
    expect(SEAM_V0_SCHEMA_VERSION).toBe('1.0.0')
  })

  it('pins the full v0 seam schema (golden — a later drift fails)', () => {
    expect(SEAM_V0_SCHEMA).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://sentropic.dev/schema/harness-track-seam/v0',
      title: 'harness↔track seam v0',
      description:
        'The frozen v0 evidence seam: the WorkEvent envelope (the ROOT schema) with a kind-driven payload dispatch, the three seam payloads (scope.verification, acceptance.run, acceptance.link) + the harness-internal per-check VerificationRun the adapter fans out from. The harness EMITS these; track INGESTS them. Neither imports the other runtime.',
      version: '1.0.0',
      ingestContractVersion: '1.1.0',
      readContractVersion: '1.9.0',
      type: 'object',
      required: ['v', 'kind', 'payload'],
      additionalProperties: false,
      properties: {
        v: { const: 1, description: 'Contract major. Unknown major ⇒ fail-closed reject.' },
        kind: { enum: ['scope.verification', 'acceptance.run', 'acceptance.link'] },
        payload: {
          type: 'object',
          description: 'Per-kind shape enforced by the allOf/if-then dispatch below (NOT a bare {type:object}).',
        },
        clientToken: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description:
            'Delivery idempotency key, unique per emitted op. Grammar: verification-run:{runId}:{targetKind}:{targetId} (scope/acceptance branch) and …:acceptance:{evidenceId}:link:{criterionId} (per-link). Harness HASHES any component past the 256-char cap. Race-safe under track (workspace, clientToken) under-lock idempotency.',
        },
      },
      allOf: [
        {
          if: { properties: { kind: { const: 'scope.verification' } }, required: ['kind'] },
          then: { properties: { payload: { $ref: '#/$defs/ScopeVerificationPayload' } } },
        },
        {
          if: { properties: { kind: { const: 'acceptance.run' } }, required: ['kind'] },
          then: { properties: { payload: { $ref: '#/$defs/AcceptanceRunPayload' } } },
        },
        {
          if: { properties: { kind: { const: 'acceptance.link' } }, required: ['kind'] },
          then: { properties: { payload: { $ref: '#/$defs/AcceptanceLinkPayload' } } },
        },
      ],
      $defs: {
        VerificationCategory: {
          description: 'Reserved enum (security pre-reserved). Validates/defaults the acceptance kind at the adapter; NOT a track wire payload field, NOT routing (routing is target-driven).',
          enum: ['scope', 'acceptance', 'security'],
        },
        Verdict: {
          description: 'The adapter-DERIVED tri-state path verdict (NEVER the harness check result). Derived from violations+severity: any blocking ⇒ violation; advisory-only ⇒ conditional; none ⇒ clean.',
          enum: ['clean', 'violation', 'conditional'],
        },
        Severity: {
          description: 'Per-violation severity (harness guarantees it is always set). Drives the Verdict derivation predicate.',
          enum: ['advisory', 'blocking'],
        },
        EvidenceKind: { enum: ['unit', 'integration', 'e2e', 'manual'] },
        RunResult: { description: 'Binary (no conditional home for acceptance).', enum: ['pass', 'fail'] },
        Violation: {
          description: 'A scope.verification.violations[] entry is the deterministic JSON.stringify({severity,code,path,message}) projection (S2) — a display/index string track records VERBATIM and NEVER parses. The canonical detail is the full VerificationRun behind artifactLocator.',
          type: 'object',
          required: ['severity', 'code', 'path', 'message'],
          additionalProperties: false,
          properties: {
            severity: { $ref: '#/$defs/Severity' },
            code: { type: 'string' },
            path: { type: 'string' },
            message: { type: 'string' },
          },
        },
        VerificationCheck: {
          description: 'One check within a VerificationRun (per-CHECK target — one harness verify aggregates N checks across WPs/criteria). ≥1 target REQUIRED; a target-less check FAILS CLOSED at the adapter (never emitted).',
          type: 'object',
          required: ['category', 'result', 'target'],
          additionalProperties: false,
          properties: {
            category: { $ref: '#/$defs/VerificationCategory' },
            result: { $ref: '#/$defs/RunResult' },
            violations: { type: 'array', items: { $ref: '#/$defs/Violation' } },
            target: {
              type: 'object',
              description: 'At least ONE of scope|acceptance REQUIRED (both empty ⇒ FAIL-CLOSED, never auto-itemized/glob-routed). Routing is TARGET-driven, never category/path/branch.',
              minProperties: 1,
              additionalProperties: false,
              properties: {
                scope: {
                  type: 'object',
                  required: ['wpRef'],
                  additionalProperties: false,
                  properties: { wpRef: { type: 'string', minLength: 1, description: 'The WP/spec-phase ItemId the verdict pertains to (the scope-target routing key = track scope.verification.wpRef).' } },
                },
                acceptance: {
                  type: 'object',
                  required: ['evidenceId', 'kind'],
                  additionalProperties: false,
                  properties: {
                    evidenceId: { type: 'string', minLength: 1, description: 'A DETERMINISTIC, caller-supplied evidence key (M2=B). The adapter sets it on acceptance.link AND references it on acceptance.run — single-phase, replayable (no two-phase read).' },
                    kind: { $ref: '#/$defs/EvidenceKind' },
                    criterionIds: { type: 'array', items: { type: 'string', minLength: 1 } },
                  },
                },
              },
            },
          },
        },
        VerificationRun: {
          description: 'The harness-internal per-check artifact behind artifactLocator (published for contract-snapshot; NOT a track kind — track ingests its target-routed projection). runId here is the per-emitted-verdict PROJECTION id (globally unique per emitted verdict — the M1 invariant), distinct from any physical run id inside the full artifact.',
          type: 'object',
          required: ['runId', 'runner', 'commit', 'artifactLocator', 'checks'],
          additionalProperties: false,
          properties: {
            runId: { type: 'string', minLength: 1 },
            runner: { type: 'string', minLength: 1 },
            commit: { type: 'string', minLength: 1 },
            env: { type: 'string' },
            artifactLocator: { type: 'string', minLength: 1, description: 'Immutable, producer-owned locator string to THIS full JSON (S2). OPAQUE to track (records, never fetches/resolves/owns). Immutability is a PRODUCER guarantee track records, never verifies.' },
            checks: { type: 'array', items: { $ref: '#/$defs/VerificationCheck' } },
          },
        },
        ScopeVerificationPayload: {
          description: 'The scope-target projection (one per target.scope branch). 7 shipped fields + the NEW additive optional artifactLocator (S2). Non-empty strings carry minLength:1 to match the runtime asserter (assertVerificationRun).',
          type: 'object',
          required: ['runId', 'runner', 'commit', 'verdict'],
          additionalProperties: false,
          properties: {
            runId: { type: 'string', minLength: 1, description: 'The per-emitted-verdict projection id (M1 invariant: globally unique per emitted verdict).' },
            runner: { type: 'string', minLength: 1 },
            commit: { type: 'string', minLength: 1 },
            verdict: { $ref: '#/$defs/Verdict' },
            env: { type: 'string' },
            wpRef: { type: 'string', minLength: 1, description: 'IS target.scope.wpRef. Absent ⇒ a workspace-scoped synthetic-aggregate run (kept OPTIONAL — fail-closed-no-target is enforced ADAPTER-side, OQ-2). Non-empty when present (assertVerificationRun).' },
            violations: { type: 'array', items: { type: 'string' }, description: 'The deterministic-stringify Violation projection (S2). Recorded VERBATIM; track never parses/re-matches.' },
            artifactLocator: { type: 'string', minLength: 1, description: 'NEW additive optional (S2). OPAQUE to track. Non-empty when present; dropped-when-absent (hash-minimal, old logs byte-identical).' },
          },
        },
        AcceptanceRunPayload: {
          description: 'The acceptance-target run (one per target.acceptance branch). UNCHANGED by the freeze. result = the check pass/result DIRECTLY (S3), never the derived verdict.',
          type: 'object',
          required: ['evidenceId', 'commit', 'env', 'runner', 'result'],
          additionalProperties: false,
          properties: {
            evidenceId: { type: 'string', minLength: 1, description: 'References the deterministic caller-supplied key minted on acceptance.link (M2=B) — so recordRun resolves without a two-phase read.' },
            commit: { type: 'string', minLength: 1 },
            env: { type: 'string', minLength: 1 },
            runner: { type: 'string', minLength: 1 },
            result: { $ref: '#/$defs/RunResult' },
          },
        },
        AcceptanceLinkPayload: {
          description: 'One per criterionId under an acceptance branch. NEW additive optional evidenceId (M2=B): caller-supplied deterministic key; absent ⇒ shipped server-mint (back-compat).',
          type: 'object',
          required: ['criterionId', 'kind', 'locator'],
          additionalProperties: false,
          properties: {
            criterionId: { type: 'string', minLength: 1 },
            kind: { $ref: '#/$defs/EvidenceKind' },
            locator: { type: 'string', minLength: 1 },
            evidenceId: { type: 'string', minLength: 1, description: 'NEW additive optional (M2=B). The deterministic caller-supplied evidence key the harness sets so acceptance.run can reference it. Non-empty when present (linkEvidence); absent ⇒ track mints server-side (shipped behavior).' },
          },
        },
        WorkEventEnvelope: {
          description: 'The v0 wire envelope (SHIPPED, unchanged by the freeze) — published as a $def for reference; the ROOT schema IS this envelope plus the kind dispatch. Any other top-level key is rejected fail-closed (WHO/trust come from the ingest CONTEXT). The harness emits a SEQUENCE of these (one per check-target branch), never a single VerificationRun envelope.',
          type: 'object',
          required: ['v', 'kind', 'payload'],
          additionalProperties: false,
          properties: {
            v: { const: 1, description: 'Contract major. Unknown major ⇒ fail-closed reject.' },
            kind: { enum: ['scope.verification', 'acceptance.run', 'acceptance.link'] },
            payload: { type: 'object' },
            clientToken: {
              type: 'string',
              minLength: 1,
              maxLength: 256,
              description: 'Delivery idempotency key, unique per emitted op. Grammar: verification-run:{runId}:{targetKind}:{targetId} (scope/acceptance branch) and …:acceptance:{evidenceId}:link:{criterionId} (per-link). Harness HASHES any component past the 256-char cap. Race-safe under track (workspace, clientToken) under-lock idempotency.',
            },
          },
        },
      },
    })
  })

  it('reserves the security VerificationCategory (a later removal/rename fails the snapshot)', () => {
    expect(SEAM_V0_SCHEMA.$defs.VerificationCategory.enum).toEqual(['scope', 'acceptance', 'security'])
  })

  it('freezes the violation severity enum + the verdict derivation enums', () => {
    expect(SEAM_V0_SCHEMA.$defs.Severity.enum).toEqual(['advisory', 'blocking'])
    expect(SEAM_V0_SCHEMA.$defs.Verdict.enum).toEqual(['clean', 'violation', 'conditional'])
  })
})

describe('seam v0 schema is a REAL, validatable Draft-2020-12 document (MUST-FIX 2)', () => {
  it('the ROOT is the WorkEvent envelope (type:object, required v/kind/payload, no extra envelope keys)', () => {
    expect(SEAM_V0_SCHEMA.type).toBe('object')
    expect(SEAM_V0_SCHEMA.required).toEqual(['v', 'kind', 'payload'])
    expect(SEAM_V0_SCHEMA.additionalProperties).toBe(false)
    // The allowed envelope keys are exactly {v,kind,payload,clientToken}.
    expect(Object.keys(SEAM_V0_SCHEMA.properties).sort()).toEqual(['clientToken', 'kind', 'payload', 'v'])
  })

  it('dispatches on kind (allOf/if-then), and `payload` is NOT a bare {type:object}', () => {
    // The dispatch exists and is keyed on `kind`...
    expect(Array.isArray(SEAM_V0_SCHEMA.allOf)).toBe(true)
    const branches = SEAM_V0_SCHEMA.allOf.map((b) => ({
      kind: b.if.properties.kind.const,
      ref: b.then.properties.payload.$ref,
    }))
    expect(branches).toEqual([
      { kind: 'scope.verification', ref: '#/$defs/ScopeVerificationPayload' },
      { kind: 'acceptance.run', ref: '#/$defs/AcceptanceRunPayload' },
      { kind: 'acceptance.link', ref: '#/$defs/AcceptanceLinkPayload' },
    ])
    // ...and the per-kind payload subschemas it references actually exist in $defs (resolvable refs).
    for (const { ref } of branches) {
      const name = ref.replace('#/$defs/', '') as keyof typeof SEAM_V0_SCHEMA.$defs
      expect(SEAM_V0_SCHEMA.$defs[name]).toBeDefined()
    }
    // The root `payload` schema is `{type:object}` ONLY as a base; the dispatch refines it per kind — so
    // it is NOT the bare ignored `{type:object}` the reviewers flagged (the refinement carries the fields).
    const dispatchedFields = SEAM_V0_SCHEMA.$defs.ScopeVerificationPayload.properties
    expect(Object.keys(dispatchedFields).length).toBeGreaterThan(1)
    expect('runId' in dispatchedFields).toBe(true)
  })

  it('enforces minLength:1 on the non-empty strings the runtime asserts (artifactLocator, evidenceId, ids)', () => {
    expect(SEAM_V0_SCHEMA.$defs.ScopeVerificationPayload.properties.artifactLocator.minLength).toBe(1)
    expect(SEAM_V0_SCHEMA.$defs.ScopeVerificationPayload.properties.runId.minLength).toBe(1)
    expect(SEAM_V0_SCHEMA.$defs.ScopeVerificationPayload.properties.wpRef.minLength).toBe(1)
    expect(SEAM_V0_SCHEMA.$defs.AcceptanceLinkPayload.properties.evidenceId.minLength).toBe(1)
    expect(SEAM_V0_SCHEMA.$defs.AcceptanceLinkPayload.properties.criterionId.minLength).toBe(1)
    expect(SEAM_V0_SCHEMA.$defs.AcceptanceRunPayload.properties.evidenceId.minLength).toBe(1)
  })
})

describe('seam v0 schema ↔ WORK_EVENT_SCHEMA wire PARITY drift-gate (SHOULD-FIX 3b)', () => {
  // Derive {required, optional} field sets from WORK_EVENT_SCHEMA (the wire track ACTUALLY enforces) and
  // assert they EQUAL the seam payload subschema's required/properties. A future WORK_EVENT_SCHEMA change
  // (a new/renamed seam-payload field) NOT mirrored in SEAM_V0_SCHEMA fails HERE — a real drift-gate.
  const wireFields = (kind: WorkEventKind): { required: string[]; all: string[] } => {
    const fields = WORK_EVENT_SCHEMA[kind].fields
    const all = Object.keys(fields).sort()
    const required = Object.entries(fields).filter(([, s]) => s.required).map(([k]) => k).sort()
    return { required, all }
  }
  const seamFields = (kind: keyof typeof SEAM_V0_PAYLOAD_DEFS): { required: string[]; all: string[] } => {
    const def = SEAM_V0_PAYLOAD_DEFS[kind]
    return { required: [...def.required].sort(), all: Object.keys(def.properties).sort() }
  }

  it.each(['scope.verification', 'acceptance.run', 'acceptance.link'] as const)(
    '%s — seam payload required+properties match WORK_EVENT_SCHEMA',
    (kind) => {
      const wire = wireFields(kind)
      const seam = seamFields(kind)
      expect(seam.required).toEqual(wire.required) // required sets are identical
      expect(seam.all).toEqual(wire.all) // the full property set (required ∪ optional) is identical
    },
  )
})
