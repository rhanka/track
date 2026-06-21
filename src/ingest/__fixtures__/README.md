# Vendored harness seam fixture (BR-H1 drift-gate)

`harness-verification-run.schema.json` is a **read-only vendored copy** of the harness
producer-internal `VerificationRun` JSON-Schema, pinned so the track-side drift-gate
(`../seam-harness-parity.test.ts`) can assert cross-contract parity WITHOUT a network fetch,
a `@sentropic/harness` devDependency, or an install-graph coupling.

| | |
|---|---|
| **source package** | `@sentropic/harness@0.3.0` |
| **source path** | `packages/harness/schema/verification-run.schema.json` |
| **source PR** | #343 `feat/harness-verification-run-v0-targets` |
| **dialect** | JSON-Schema draft-07 (frozen) |
| **SHA-256** | `854be4e46e593ea2bc8d0b24e1d52ccc313dd547388272633ef52380b0a0fcbb` |

The SHA-256 above is **pinned in the test** (`EXPECTED_HARNESS_FIXTURE_SHA256`). An UNREVIEWED
edit to the fixture changes the digest and FAILS the gate — so any intentional harness update
lands as a reviewable fixture diff (the BR-H1 atomic-pair discipline), never a silent drift.

This is one LAYER of a two-layer pin: harness root (producer-internal pre-projection
`VerificationRun`) ↔ track's embedded agreement-mirror `$defs` in
`../seam-schema.ts`. The gate compares NORMALIZED projections (enum arrays, required arrays,
property-name sets), NEVER a whole-document `toEqual` and NEVER against the wire-projection
payloads (`ScopeVerificationPayload` etc.). Dialect (draft-07 vs 2020-12) is metadata-only.
