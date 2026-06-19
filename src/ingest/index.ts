// Ingest contract barrel (M5-host) — the in-process SUBMIT seam, reachable at `@sentropic/track/ingest`.
//
// This is the write counterpart to `./read`: a deliberate, documented submit surface, NOT `export *`. It
// exposes exactly what an IN-PROCESS host needs to construct + submit a WorkEvent and read the receipt —
// nothing of the mapper/authorizer internals.
//
// Channel model (owner-ratified "submit = A", M3-channel-DESIGN.md / M5-canevas-HOST-INTEGRATION-DESIGN.md
// §5): the host imports `ingest()` directly and CARRIES AUTH via the `IngestContext`. The WHO and the trust
// level (`by` / `workspace` / `prov.auth` / `prov.proposed` / `prov.principal`) come from the CONTEXT, fixed
// when the channel opens — NEVER per-event (the neutral WorkEvent envelope rejects any actor/sponsor/trust
// key fail-closed). A binding ("settling") write — `reparent`, `realize→done/cancelled`, `decision.outcome`,
// `add-artifact`, `waive`, `blocker.resolve`, `spec-amend`, and the `evidence` kinds — requires an
// AUTHENTICATED channel (`prov.auth ∈ BINDING_AUTH`, i.e. `{local-user, signed}`); an `unauthenticated`
// channel may only create/prepare. Workspace containment is verified against folded state (the load-bearing
// security property): a channel pinned to W can never mutate workspace V.
//
// The HTTP ingest gateway (M3) stays DEFERRED — that is a separate co-versioned package fronting `ingest()`
// over an authenticated transport; this barrel is the in-process library import that covers the co-located
// host today. track stays record-only / append-only / no-clock / no-server.
//
// The host wires its own `EventStore` (the third `ingest` arg) from the core barrel (`@sentropic/track`);
// the store is intentionally NOT part of this submit contract.

// The submit FUNCTION + its CONTEXT and RECEIPT (result) types — the surface a host calls.
//
// `isBindingAuth(auth)` / `BINDING_AUTH` are the binding-auth PRE-CHECK surface: a DECOUPLED, immutable
// view of the admit-set the host can use to ask "does my channel `prov.auth` admit binding writes?"
// BEFORE submitting. They are deliberately NOT the gate's live admit-set — `isBindingAuth` closes over a
// private module-internal Set, and `BINDING_AUTH` is a FROZEN copy (a separate object). Mutating or
// attempting to mutate this surface CANNOT influence the authorization gate; the gate's decision depends
// only on the private value (so an in-process host can never `.add('unauthenticated')` its way past it).
export { ingest, isBindingAuth, BINDING_AUTH, type IngestContext, type IngestResult } from './ingest.js'

// The neutral submit ENVELOPE + the kind enum/type — the WorkEvent the host constructs per gesture.
export { INGEST_CONTRACT_VERSION, type WorkEvent, type WorkEventKind } from './contract.js'

// The fail-closed rejection a caller MUST catch (a malformed/illegal WorkEvent, a containment violation, or
// a binding write on an unauthenticated channel). Distinct from a domain error thrown by the facade.
export { IngestError } from './map.js'
