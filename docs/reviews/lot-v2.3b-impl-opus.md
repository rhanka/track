# Lot v2.3b IMPLEMENTATION (M2b write seam) — Opus 4.8 review

Adversarial Lot-1-grade review, paired with `docs/reviews/lot-v2.3b-impl-codex.md`. **Verdict: block (one-
line fix), then ship.** Independently found the SAME P0 as Codex with the SAME fix.

## P0 — `item.realize` on a decision id bypasses containment (FIXED)
`resolveWorkspace` resolved `item.realize` only against `state.items` (`ingest.ts`), but
`Track.setRealization` resolves `items ∪ decisions` (`track.ts:133-146`): a decision id → `undefined`
workspace → the `ws.workspace !== undefined` guard skipped → "defer to Track", but Track WRITES (doesn't
throw). A channel pinned to W can realize a V **decision**; since `to:'in-progress'` is non-`realize-
terminal`, `isBinding` is false, so even an **unauthenticated** W channel can — and decision ids are
enumerable from the shared readable log. This breaks the load-bearing "a W-pinned channel can never mutate
a V aggregate" property. **Fix (one line):** resolve `item.realize` against `items ?? decisions`.
Regression test added (foreign-workspace decision, unauthenticated `in-progress`). `setRealization` is the
SOLE facade method whose resolution domain exceeds `resolveWorkspace`'s — verified every other kind.

## Confirmed sound (with citations checked against fold + facade)
- "Defer to Track on undefined-resolution" is safe for every other kind (each resolves a single aggregate
  domain and throws on miss). `decision.outcome` no-go (rejected + blocker resolves on targets) fully
  covered by `affectedTargetWorkspaces` reading folded `decision.targets`. `blocker.raise` `ref` /
  `parentId` are references, not mutations — not a write leak. Create-then-reference in one batch works
  (re-fold each iteration).
- Binding gate correct; `decision.disposition` non-binding defensible; `BINDING_AUTH` Set<string>
  pre-admitting `'signed'` is sound (fail-closed allowlist; `'signed'` can't be injected — prov comes from
  the channel, envelope rejects per-event `prov`).
- Mapper args all match the facade signatures + `fold`; envelope/payload-field rejection complete and
  fail-closed; `isPlainObject` guards null/array.
- CLI verb sound (`transport:'import'`, workspace required, fail-closed JSONL). Frozen contract upheld; no
  new event types / seq / prevHash / hash change; removing envelope `proposed` is a correct improvement
  ("a per-event `proposed` would let an event self-assert a trust property — exactly what WHO-from-channel
  forbids").

## Non-blocking (addressed / noted)
- **Parity gate broadened** to all 14 kinds + a no-go (rejected) batch + terminal realize (was 12 kinds +
  go only).
- **At-least-once = under-flagged footgun:** the loop is non-atomic (a failure at event k leaves 1..k-1
  committed) AND `createItem` ignores `sourceKey` for dedup, so an auto-retrying CI consumer DUPLICATES
  already-applied creates. Now flagged loudly in code + design; prerequisite for any M3 auto-retry channel.
- Minor (noted): `dossier` inner shape unchecked (data-integrity, not security); `track.state()` re-folds
  the whole log per event (O(n²) per batch — fine for small CI batches); exit-code skew (missing file → 2,
  missing flag → 1, the latter matching the CLI-wide `req()` convention).

## Outcome
262 tests green; typecheck + build clean. Ships as 0.3.0.
