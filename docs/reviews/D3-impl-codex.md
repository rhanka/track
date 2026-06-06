# D3 provenance contract — Codex (gpt-5.5 xhigh) review

Lot-1-grade review of the additive `prov` event-core field + CLI attribution fix. Paired with `docs/reviews/D3-impl-opus.md` (Opus 4.8, verdict **ship**).

## Verdict: ship-with-changes → all changes applied

### major — batch provenance not enforced for a live/adversarial `prov` (FIXED)
`emitBatch` reused the external `TrackOptions.prov` reference and `EventStore` materialized each event separately, so a **Proxy/mutable `prov`** could make members of one `cmdId` batch persist mixed values while `validate()` still returned ok (hash coverage itself was intact). **Fix:** snapshot `prov` once into an inert plain object at construction (`this.prov = opts.prov ? { ...opts.prov } : undefined`, `track.ts`) — a Proxy is read exactly once into a flat snapshot, so no later read can vary. Proven by a new test: mutating the caller's `prov` *after* construction leaves every emitted batch member carrying the construction snapshot.

### minor — premature `signed` auth state (FIXED)
`auth` included `'signed'` although nothing in 0.2.0 produces or verifies a signature. **Fix:** narrowed `auth` to `'local-user' | 'unauthenticated'`; M3/h2a widens it additively with `'signed'` + `sig`/`principal`. SPEC §3 updated.

### test gaps (FIXED, also raised by Opus)
Added: prov on every member of a multi-event `cmdId` batch; a log MIXING prov and non-prov events validating; prov on branch-import events; the construction-snapshot proof.

## Confirmed sound (Codex + Opus)
- **Additive/backward-compat:** a no-prov core hashes byte-identically to a pre-D3 core (`canonicalize` drops `undefined`); existing logs + `prevHash` chains unaffected.
- **A4 hash-domain:** `prov` is covered by `contentHashOf`/`stripFrame` + materialize-once; a getter-`prov` or Date-`prov` is rejected by `canonicalize`; a tampered `prov` is a content-hash finding.
- **Frozen contract:** no stream/seq/chain/batch-semantics change; `validate` reads no prov; prov-carrying logs validate ok.
- **CLI actor:** `cliActor` never emits `'system'`; falls through git-absent/empty to `cli:unknown`.
- **Read-path:** `fold`, `TrackReader`, the read-only MCP server are all prov-blind.

## Note (not added — redundant)
A `validate` rule "all members of a `cmdId` batch share identical prov" was suggested as defense-in-depth. Not added: the construction snapshot makes the WRITE path produce uniform batches, and a hand-crafted mixed-prov batch already fails the existing `content-hash` check unless the whole log is re-chained — which is in the frozen threat-model exclusion. The rule would be redundant with existing integrity.

## Outcome
209 tests green, tsc + build clean. Ships in 0.2.0.
