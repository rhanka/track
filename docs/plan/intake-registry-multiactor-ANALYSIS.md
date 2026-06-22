# Analysis — complementary registry for intake / in-flight / multi-actor (file-first review)

**Status:** analysis (no decision yet). Pair: Codex 5.5xhigh + Opus 4.8max (converged). Reconciled by the
track conductor for the owner. Driver: owner-observed multi-worktree / multi-session strain on the file-first
single-writer model — specifically (a) concurrent actors, (b) demand intake before dedup/analysis is written,
(c) in-flight analysis tracking with NO completion guarantee.

## A) État des lieux (grounded)

The current model is an **append-only single-stream log; the in-flight phase is deliberately OUTSIDE track.**

- Writes are serialized by a lockfile (`src/events/lock.ts`, since 0.2.2) — but **same-host/local-FS only**
  (NFS out of scope, `CHANGELOG.md:596`), and it protects **stream integrity, not semantic freshness**.
- ⚠️ **Semantic-race gap (Codex).** Two actors fold the SAME pre-lock state and append two events that are
  structurally valid but semantically contradictory (e.g. two `decision.outcome` from `pending`; the
  `go→no-go` transition is illegal per `src/model/decision.ts:115`). The store validates structural integrity
  (`src/events/validate.ts:42`), NOT domain legality of the new suffix under the lock. A real multi-actor hole,
  **orthogonal** to the registry question.
- Idempotency `(workspace, clientToken)` (`src/ingest/ingest.ts:344`) dedups a **retry** of one command, not two
  legitimate concurrent commands.
- Durable workspace id `ws:sha256(rootCommit + worktreeRelPath)` exists as a helper (`src/workspace-id.ts`) but
  ingest still takes `workspace` as a context string (`CHANGELOG.md:339`).
- ⚠️ **Greenfield, confirmed corpus-wide (Opus).** `intake`/`staging`/`in-flight`/`ephemeral`/`abandon`/`scratch`/
  `WIP` = ZERO hits across all of `docs/plan/`. It is BY DESIGN INTENT, not omission: in track a unit of work is
  either an appended (settled) event or it does not exist; the in-flight phase is pushed OUTSIDE track (to
  h2a / the harness / the caller). track's stated identity: "track records; it does not coordinate"
  (`M3-deps-raci-DESIGN.md:13-15`); coordination delegated to h2a (INTENTION boundary A).
- Where it breaks: **(a)** no claim/lease/ownership + no under-lock semantic recheck → uncoordinated concurrency;
  true multi-writer = a new frozen-contract round (`PLAN-v2.md:83`). **(b)** a demand before dedup/analysis has
  no place in the model. **(c)** tracking an in-flight analysis forces appending durable backlog → an abandoned
  analysis becomes a durable fact to compensate.

## B) Convergent shape (IF an in-flight space is built)

Both halves agree:
- **No new backlog events** in the frozen contract for the in-flight phase. **No** true multi-writer merge.
- An in-flight space, if any, is **ephemeral, mutable, OUTSIDE the frozen contract**, scoped by the durable
  workspace id, separating `intake` / `analysis` / `leases`, with TTL/heartbeat, **explicit promotion via the
  existing `ingest()`** at settlement (storing the returned event ids back), and **advisory reads** (never folded
  state). Abandonment detected by lease/TTL expiry (optionally correlated with `workspaceActivity.latestEventAt`).
- **The lease is already track's chosen multi-writer answer.** `PLAN-v2.md:101` D2 default =
  "lease-lock / single-writer-per-lease, no in-track merge" → "M4 largely collapses into M3". So it is not a
  concept to ratify but a deferred one to instantiate.

## C) The genuine fork (owner orientation decision)

**Where does the intake / in-flight / lease space live?**

- **Fork A — track grows the ephemeral registry** (`.track/intake|analysis|leases`, advisory, off-contract).
  *Pro:* one tool co-located with the settlement sink; track can co-surface in-flight + backlog (e.g. a canevas
  "3 demands in intake, 1 analysis in-flight" beside settled items). *Con:* track now holds coordination state
  (leases/claims) → erodes its "records-not-coordinates" purity; a second operational surface to keep clean.
- **Fork B — h2a / conductor owns intake + lease; track stays the pure settlement sink** (Opus's reframe,
  consistent with track's declared boundary). *Pro:* preserves track's purity + the existing RACI; REUSES h2a's
  existing primitives (lease/blockage/conductor-launch + polling `workspaceActivity`). *Con:* the in-flight is
  not in track → a track-only consumer cannot see it.

## Recommendation

**Default Fork B + one targeted exception**, because track defines itself as "records, never coordinates" and D2
already delegated the lease to the coordination (h2a) layer:
1. **Lease / coordination → h2a side** (instantiate the D2 lease-lock there; it already has lease/blockage).
   track does NOT grow coordination state.
2. **Intake / dedup staging → h2a/conductor by default**; track sees a demand only at **settlement** (promotion
   via `ingest()`). **Exception:** if co-displaying in-flight + backlog in a track read (canevas/report) is
   genuinely needed, add a minimal **ephemeral, advisory, off-contract** track surface (Fork A-lite) — but
   **deferred** until a concrete consumer needs it (avoid a speculative second surface).
3. **Independently (track lane, regardless of the fork): fix the semantic-race** — an under-lock domain-legality
   recheck (or an optimistic `expectedHead` token on `appendCommand`) so two concurrent commands cannot produce
   contradictory-but-valid events. A real multi-actor correctness gap in the settlement path.

## Owner decisions to put
1. **Orientation Fork A vs B** (track grows the registry, or h2a owns it + track stays pure).
2. Abandoned intake = **durable audit** or **disposable cache**? (under `.track/`, gitignored?).
3. Priority of the **semantic-race fix** (independent, but real).

## Next step
On the owner's orientation pick (A / B / hybrid): delegate the detailed design spec to the pair (exact lease
shape + the h2a↔track boundary + the promotion seam) and open a track decision-dossier to record the choice.
