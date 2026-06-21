// The harness↔track seam v0 JSON-Schema artifact (owner-ratified FREEZE — see
// docs/plan/harness-seam-v0-FREEZE-DESIGN.md §9). This is the CONSUMABLE contract the harness
// validates its emit against and contract-snapshots (BR-H1) — both sides pin the same golden so a drift
// fails on either side. It describes:
//   - the WorkEvent ENVELOPE {v,kind,payload,clientToken} (SHIPPED, unchanged by the freeze);
//   - the three seam PAYLOADS: scope.verification (with the NEW artifactLocator), acceptance.run,
//     acceptance.link (with the NEW caller-supplied evidenceId);
//   - the harness-INTERNAL per-check VerificationRun / VerificationCheck.target shape the adapter fans
//     out from (published for agreement; track ingests only its target-routed projection);
//   - the FROZEN enums: VerificationCategory (scope|acceptance|security — security pre-reserved), the
//     violation Severity (advisory|blocking), the tri-state Verdict (clean|violation|conditional), the
//     binary RunResult (pass|fail), the EvidenceKind.
//
// track NEVER imports the harness runtime and vice-versa; this artifact is the only shared surface.
// It is a REAL, validatable Draft-2020-12 document: the root is the WorkEvent ENVELOPE with a
// `kind`-driven `allOf`+`if/then` dispatch that applies the correct per-kind payload subschema (the
// payload subschemas live in `$defs`, referenced by the dispatch — NOT a custom top-level key a
// validator would ignore). A standard validator (e.g. ajv) therefore ENFORCES the wire field-by-field,
// including `minLength:1` on the non-empty strings the runtime asserters reject empty
// (assertVerificationRun: runId/runner/commit/wpRef?/artifactLocator?; linkEvidence: evidenceId?).
// track does not validate against it at runtime (the wire is validated by WORK_EVENT_SCHEMA + the facade
// asserters); it exists so the two repos agree on the frozen shape.

/** Semver of the seam v0 schema artifact itself (the contract-snapshot version, distinct from the
 *  INGEST/READ contract versions it references). Bumped MINOR for additive schema growth. */
export const SEAM_V0_SCHEMA_VERSION = '1.0.0'

/** The frozen v0 seam JSON-Schema (Draft 2020-12) — a REAL envelope schema with a kind dispatch (validatable
 *  by a standard validator). Pinned by `seam-schema.test.ts` (the snapshot gate + the WORK_EVENT_SCHEMA
 *  wire-parity drift-gate). */
export const SEAM_V0_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://sentropic.dev/schema/harness-track-seam/v0',
  title: 'harness↔track seam v0',
  description:
    'The frozen v0 evidence seam: the WorkEvent envelope (the ROOT schema) with a kind-driven payload dispatch, the three seam payloads (scope.verification, acceptance.run, acceptance.link) + the harness-internal per-check VerificationRun the adapter fans out from. The harness EMITS these; track INGESTS them. Neither imports the other runtime.',
  version: '1.0.0',
  ingestContractVersion: '1.1.0',
  readContractVersion: '1.9.0',
  // The ROOT IS the WorkEvent envelope (validatable): required keys + no extra envelope keys, then an
  // allOf/if-then dispatch on `kind` that applies the matching per-kind payload subschema from $defs.
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
  // Kind dispatch: each branch applies the matching payload subschema to `payload` (and pins `kind`). A
  // standard Draft-2020-12 validator enforces the correct per-kind payload field-by-field.
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
      description:
        'Reserved enum (security pre-reserved). Validates/defaults the acceptance kind at the adapter; NOT a track wire payload field, NOT routing (routing is target-driven).',
      enum: ['scope', 'acceptance', 'security'],
    },
    Verdict: {
      description:
        'The adapter-DERIVED tri-state path verdict (NEVER the harness check result). Derived from violations+severity: any blocking ⇒ violation; advisory-only ⇒ conditional; none ⇒ clean.',
      enum: ['clean', 'violation', 'conditional'],
    },
    Severity: {
      description:
        'Per-violation severity (harness guarantees it is always set). Drives the Verdict derivation predicate.',
      enum: ['advisory', 'blocking'],
    },
    EvidenceKind: { enum: ['unit', 'integration', 'e2e', 'manual'] },
    RunResult: { description: 'Binary (no conditional home for acceptance).', enum: ['pass', 'fail'] },
    Violation: {
      description:
        'A scope.verification.violations[] entry is the deterministic JSON.stringify({severity,code,path,message}) projection (S2) — a display/index string track records VERBATIM and NEVER parses. The canonical detail is the full VerificationRun behind artifactLocator. D2 (BR-H1): `path` is OPTIONAL (a violation need not be path-scoped — matches harness Violation.required). CANONICAL path-less rule: a violation WITHOUT a path OMITS the `path` key from the deterministic JSON.stringify({severity,code,path,message}) projection — NEVER an empty-string fill (the empty string is a real, distinct path; omission keeps the projection stable + collision-free). NOTE (BR-H1 lot): track does NOT perform this stringify yet — `violations[]` is a string[] recorded VERBATIM (see assertVerificationRun); the full VerificationRun→violations[] adapter is a later lot, so this OMIT rule is DOCUMENTATION-ONLY here.',
      type: 'object',
      required: ['severity', 'code', 'message'],
      additionalProperties: false,
      properties: {
        severity: { $ref: '#/$defs/Severity' },
        code: { type: 'string' },
        path: { type: 'string' },
        message: { type: 'string' },
      },
    },
    VerificationCheck: {
      description:
        'One check within a VerificationRun (per-CHECK target — one harness verify aggregates N checks across WPs/criteria). D1 (BR-H1): `target` is OPTIONAL on the check (matches harness VerificationCheck.required — producer-local checks stay representable). Fail-closed-no-target is an ADAPTER behavior (OQ-2), NOT a schema requirement: a track-ingested check needs ≥1 of scope|acceptance, and a target-less check FAILS CLOSED at the adapter (never emitted) — but the SCHEMA does not require it.',
      type: 'object',
      required: ['category', 'result'],
      additionalProperties: false,
      properties: {
        category: { $ref: '#/$defs/VerificationCategory' },
        result: { $ref: '#/$defs/RunResult' },
        violations: { type: 'array', items: { $ref: '#/$defs/Violation' } },
        target: {
          type: 'object',
          description:
            'At least ONE of scope|acceptance REQUIRED (both empty ⇒ FAIL-CLOSED, never auto-itemized/glob-routed). Routing is TARGET-driven, never category/path/branch.',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            scope: {
              type: 'object',
              required: ['wpRef'],
              additionalProperties: false,
              properties: {
                wpRef: {
                  type: 'string',
                  minLength: 1,
                  description:
                    'The WP/spec-phase ItemId the verdict pertains to (the scope-target routing key = track scope.verification.wpRef).',
                },
              },
            },
            acceptance: {
              type: 'object',
              required: ['evidenceId', 'kind'],
              additionalProperties: false,
              properties: {
                evidenceId: {
                  type: 'string',
                  minLength: 1,
                  description:
                    'A DETERMINISTIC, caller-supplied evidence key (M2=B). The adapter sets it on acceptance.link AND references it on acceptance.run — single-phase, replayable (no two-phase read).',
                },
                kind: { $ref: '#/$defs/EvidenceKind' },
                criterionIds: { type: 'array', items: { type: 'string', minLength: 1 } },
              },
            },
          },
        },
      },
    },
    VerificationRun: {
      description:
        'The harness-internal per-check artifact behind artifactLocator (published for contract-snapshot; NOT a track kind — track ingests its target-routed projection). M1 (BR-H1): runId here is the PHYSICAL per-invocation run id (stable per harness invocation — matches the harness VerificationRun.runId). The per-emitted-verdict PROJECTION id (globally unique per emitted verdict — the M1 invariant) is adapter-MINTED and lives on the emitted ScopeVerificationPayload.runId, NOT here.',
      type: 'object',
      required: ['runId', 'runner', 'commit', 'artifactLocator', 'checks'],
      additionalProperties: false,
      properties: {
        runId: {
          type: 'string',
          minLength: 1,
          description:
            'The PHYSICAL per-invocation harness run id (matches harness VerificationRun.runId). The per-verdict projection id is on ScopeVerificationPayload.runId (adapter-minted), not this physical id (M1).',
        },
        runner: { type: 'string', minLength: 1 },
        commit: { type: 'string', minLength: 1 },
        env: { type: 'string' },
        artifactLocator: {
          type: 'string',
          minLength: 1,
          description:
            'Immutable, producer-owned locator string to THIS full JSON (S2). OPAQUE to track (records, never fetches/resolves/owns). Immutability is a PRODUCER guarantee track records, never verifies.',
        },
        checks: { type: 'array', items: { $ref: '#/$defs/VerificationCheck' } },
      },
    },
    // --- the three seam PAYLOAD subschemas (referenced by the root kind dispatch) ---
    ScopeVerificationPayload: {
      description:
        'The scope-target projection (one per target.scope branch). 7 shipped fields + the NEW additive optional artifactLocator (S2). Non-empty strings carry minLength:1 to match the runtime asserter (assertVerificationRun).',
      type: 'object',
      required: ['runId', 'runner', 'commit', 'verdict'],
      additionalProperties: false,
      properties: {
        runId: {
          type: 'string',
          minLength: 1,
          description: 'The per-emitted-verdict projection id (M1 invariant: globally unique per emitted verdict).',
        },
        runner: { type: 'string', minLength: 1 },
        commit: { type: 'string', minLength: 1 },
        verdict: { $ref: '#/$defs/Verdict' },
        env: { type: 'string' },
        wpRef: {
          type: 'string',
          minLength: 1,
          description:
            'IS target.scope.wpRef. Absent ⇒ a workspace-scoped synthetic-aggregate run (kept OPTIONAL — fail-closed-no-target is enforced ADAPTER-side, OQ-2). Non-empty when present (assertVerificationRun).',
        },
        violations: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The deterministic-stringify Violation projection (S2). Recorded VERBATIM; track never parses/re-matches.',
        },
        artifactLocator: {
          type: 'string',
          minLength: 1,
          description:
            'NEW additive optional (S2). OPAQUE to track. Non-empty when present; dropped-when-absent (hash-minimal, old logs byte-identical).',
        },
      },
    },
    AcceptanceRunPayload: {
      description:
        'The acceptance-target run (one per target.acceptance branch). UNCHANGED by the freeze. result = the check pass/result DIRECTLY (S3), never the derived verdict.',
      type: 'object',
      required: ['evidenceId', 'commit', 'env', 'runner', 'result'],
      additionalProperties: false,
      properties: {
        evidenceId: {
          type: 'string',
          minLength: 1,
          description:
            'References the deterministic caller-supplied key minted on acceptance.link (M2=B) — so recordRun resolves without a two-phase read.',
        },
        commit: { type: 'string', minLength: 1 },
        env: { type: 'string', minLength: 1 },
        runner: { type: 'string', minLength: 1 },
        result: { $ref: '#/$defs/RunResult' },
      },
    },
    AcceptanceLinkPayload: {
      description:
        'One per criterionId under an acceptance branch. NEW additive optional evidenceId (M2=B): caller-supplied deterministic key; absent ⇒ shipped server-mint (back-compat).',
      type: 'object',
      required: ['criterionId', 'kind', 'locator'],
      additionalProperties: false,
      properties: {
        criterionId: { type: 'string', minLength: 1 },
        kind: { $ref: '#/$defs/EvidenceKind' },
        locator: { type: 'string', minLength: 1 },
        evidenceId: {
          type: 'string',
          minLength: 1,
          description:
            'NEW additive optional (M2=B). The deterministic caller-supplied evidence key the harness sets so acceptance.run can reference it. Non-empty when present (linkEvidence); absent ⇒ track mints server-side (shipped behavior).',
        },
      },
    },
    WorkEventEnvelope: {
      description:
        'The v0 wire envelope (SHIPPED, unchanged by the freeze) — published as a $def for reference; the ROOT schema IS this envelope plus the kind dispatch. Any other top-level key is rejected fail-closed (WHO/trust come from the ingest CONTEXT). The harness emits a SEQUENCE of these (one per check-target branch), never a single VerificationRun envelope.',
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
          description:
            'Delivery idempotency key, unique per emitted op. Grammar: verification-run:{runId}:{targetKind}:{targetId} (scope/acceptance branch) and …:acceptance:{evidenceId}:link:{criterionId} (per-link). Harness HASHES any component past the 256-char cap. Race-safe under track (workspace, clientToken) under-lock idempotency.',
        },
      },
    },
  },
} as const

/**
 * The per-kind seam payload subschemas, addressed by kind (the dispatch targets). Exposed so the
 * wire-parity drift-gate (`seam-schema.test.ts`) can derive {required, properties} per kind and assert
 * equality with `WORK_EVENT_SCHEMA` — the canonical mapping from a WorkEventKind to its payload $def.
 */
export const SEAM_V0_PAYLOAD_DEFS = {
  'scope.verification': SEAM_V0_SCHEMA.$defs.ScopeVerificationPayload,
  'acceptance.run': SEAM_V0_SCHEMA.$defs.AcceptanceRunPayload,
  'acceptance.link': SEAM_V0_SCHEMA.$defs.AcceptanceLinkPayload,
} as const
