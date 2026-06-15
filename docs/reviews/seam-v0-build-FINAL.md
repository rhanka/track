# seam v0 build — pair-review convergence record (track-side)

**Date:** 2026-06-15 · **Outcome: SHIP** (Opus 4.8max SHIP; Codex 5.5xhigh's two BLOCKs both resolved & verified).
The pair drove three rounds; each round found a REAL defect; all resolved. Reviews:
`seam-v0-spec-{codex,opus}.md` (spec), `seam-v0-build-{codex,opus}.md` (round 1), this doc (rounds 2-3).

## Round 1 (build) — Codex BLOCK / Opus SHIP-WITH-CHANGES
- **MUST-FIX (Codex): `SEAM_V0_SCHEMA` was not a usable validation schema** — no root dispatch, payloads under a
  custom key validators ignore, no `minLength`. → REWRITTEN to a real Draft-2020-12 (root envelope + `allOf`/`if-then`
  dispatch on `kind` → `$defs`, `minLength:1`). **Verified by Codex round-3 with ajv2020: compiles + accepts/rejects
  the expected cases.** RESOLVED.
- **MUST-FIX (both): caller-supplied `evidenceId` collision** (clobber/squat of the global evidence map). → added a
  fail-closed guard in `linkEvidence`. (Then round 2 found the guard regressed idempotency — below.)
- SHOULD-FIX: schema↔WORK_EVENT_SCHEMA parity drift-gate (added); additive-hash on a hardcoded pre-freeze fixture
  (added); map.test real coverage gate (20 kinds). All RESOLVED.

## Round 2 — Codex BLOCK / Opus (logged as residual)
- **MUST-FIX (Codex; Opus logged it): the collision guard regressed the 0.12.0 idempotency seam.** A legitimate
  CONCURRENT same-`clientToken` retry of a caller-supplied `evidenceId` threw `already exists` (the `linkEvidence`
  fresh fold saw the first writer) BEFORE the under-lock `workspaceDedupe` could return the original. Conductor
  upheld BLOCK (it's a real regression to a shipped guarantee, reachable in the actual concurrent M3-HTTP path).

## Round 3 — token-aware guard fix → SHIP
- FIX: the fold carries `originClientToken` onto the IN-MEMORY evidence state (derived from the already-hash-covered
  `event.clientToken`; ZERO contentHash/contract impact — the pinned 0.12.0 pre-freeze hash `sha256:1f59…8544`
  reproduces byte-identical). The guard throws ONLY when it is NOT the same delivery being retried:
  `evidenceIdInput!==undefined && existing!==undefined && !(activeClientToken!==undefined &&
  existing.originClientToken===activeClientToken)`. Same-token retry ⇒ no throw ⇒ the under-lock dedup returns the
  original; different-token / untokened / no-origin-token ⇒ throw (collision fail-closed).
- **Opus round-3: SHIP** — verified end-to-end against the real window (`StaleFastPathStore`: fast-path tokenIndex
  stale, linkEvidence fold fresh): concurrent same-token retry dedups to ONE event + returns the original WITHOUT
  throwing; different-token + untokened re-use still throw (no clobber reopened); zero hash impact (pinned literal +
  snapshot round-trip); edge directions (untokened↔tokened) correct; no new false-pos/neg. 623+4 tests.
- **Codex round-3:** confirmed the schema RESOLVED (ajv-validated) and raised exactly the guard regression now fixed;
  its re-review of the fix ran slow (reading skills) and did not return a final line before release. Proceeded on
  Opus's exhaustive SHIP + the verified resolution of Codex's exact MUST-FIX + 4 targeted passing tests + owner
  authorization to proceed when the tool stalls. The two Codex BLOCK items are both objectively, test-provably resolved.

## Verification at release
`npx vitest run --no-file-parallelism` → 623 passed (49 files); `npm run typecheck` clean; `npm run build` clean.
Frozen contract intact (additive-only, old logs byte-identical), M1 invariant fixture + structural inertness intact.
