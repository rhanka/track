// Lot v2.3b-2 — apply a neutral WorkEvent stream through the Track facade, under channel-bound
// authorization. The WHO/trust come from the IngestContext (fixed when the channel opens), never the
// event. Two gates run before every apply, against FRESHLY FOLDED state:
//   1. workspace containment — the affected aggregate's workspace must equal ctx.workspace. For existing
//      aggregates this is resolved from folded state (payload carries no workspace for them); a channel
//      pinned to W can therefore never mutate workspace V. This is the load-bearing security property.
//   2. binding gate — a settling write (decision.outcome, waive, realize→done/cancelled, blocker.resolve,
//      acceptance.run) is allowed only on an authenticated channel (auth ∈ {local-user, signed}); an
//      unauthenticated channel may only create/prepare.
// State is re-folded each iteration, so an id created earlier in the same batch resolves to ctx.workspace.

import type { RunResult } from '../model/acceptance.js'
import type { Dossier, DossierArtifact, Outcome } from '../model/decision.js'
import type { Disposition, Gate, ItemId, Realization, ScopeDecl, SpecStatus } from '../model/item.js'
import type { ItemCreatedPayload } from '../model/item.js'
import type { DecisionCreatedPayload } from '../model/decision.js'
import type { WsjfInputs } from '../model/priority.js'
import type { VerificationRecordedPayload } from '../model/verification.js'
import type { SpecAmendPayload } from '../model/spec-amend.js'
import type { ActorId, CommandEvent, Provenance, TrackEvent, Ulid } from '../events/types.js'
import type { EventStore } from '../events/store.js'
import { fold, type State } from '../state/fold.js'
import { Track, type DedupeHook, type OpenBlockerInput } from '../track.js'
import type { WorkEvent, WorkEventKind } from './contract.js'
import { IngestError, mapWorkEvent, type MappedCommand } from './map.js'

export interface IngestContext {
  /** Actor recorded as `by`, fixed for the channel (CLI: cliActor; M3 HTTP: verified principal). */
  by: ActorId
  /** The pinned workspace — containment is verified against folded state. */
  workspace: string
  /** Provenance stamped on every write (its `auth` gates binding kinds). */
  prov: Provenance
  /** Capability allowlist of permitted kinds; default = all. */
  allowedKinds?: ReadonlySet<WorkEventKind>
  now?: () => string
  newId?: () => Ulid
}

export interface IngestResult {
  /** Assigned id per event (null for a non-creating kind), in input order. */
  ids: Array<string | null>
  count: number
}

// Allowlist (not `!== 'unauthenticated'`, which would admit any future enum value). `'signed'` is
// pre-listed so M3 adding it to Provenance['auth'] unlocks binding with no change here; today the only
// valid authenticated value is 'local-user'.
const BINDING_AUTH: ReadonlySet<string> = new Set(['local-user', 'signed'])

/** Does this command settle state (⇒ requires an authenticated channel)? */
function isBinding(cmd: MappedCommand): boolean {
  switch (cmd.settles) {
    case 'never':
      return false
    case 'always':
    case 'evidence':
      return true
    case 'realize-terminal': {
      const to = cmd.payload['to']
      return to === 'done' || to === 'cancelled'
    }
  }
}

/**
 * The workspace of the aggregate this command affects. `create` kinds carry it in the payload; all
 * others address a pre-existing aggregate whose workspace is resolved from folded state (undefined if the
 * aggregate does not exist — the Track method will then throw its own domain error, so no write happens).
 */
function resolveWorkspace(cmd: MappedCommand, state: State): { create: boolean; workspace: string | undefined } {
  const p = cmd.payload
  const item = (id: unknown): string | undefined => state.items.get(id as ItemId)?.workspace
  switch (cmd.kind) {
    case 'item.create':
    case 'decision.create':
      return { create: true, workspace: p['workspace'] as string }
    case 'item.realize':
      // setRealization resolves items ∪ decisions (a decision has a prep/realization axis); resolving
      // only against items would leave a foreign-workspace DECISION reachable — a containment bypass.
      return { create: false, workspace: item(p['itemId']) ?? state.decisions.get(p['itemId'] as ItemId)?.workspace }
    case 'item.reparent':
      // The CHILD item is the mutated aggregate; the new parent is checked via affectedTargetWorkspaces.
      return { create: false, workspace: item(p['itemId']) }
    case 'item.spec':
    case 'acceptance.criterion':
    case 'priority.assess':
    case 'decision.disposition':
    case 'scope.declare':
      // Scope §B(a) — declareScope mutates the named item aggregate; contained by the item's workspace
      // (a W-pinned channel can't declare scope on a V item). Resolved from folded state.
      return { create: false, workspace: item(p['itemId']) }
    case 'item.spec-amend':
      // M5 (canevas) — amendSpec mutates the named item aggregate; contained by the item's workspace
      // (a W-pinned channel can't amend a V item's spec). Resolved from folded state.
      return { create: false, workspace: item(p['itemId']) }
    case 'decision.outcome':
    case 'decision.dossier':
    case 'decision.add-artifact':
      return { create: false, workspace: state.decisions.get(p['decisionId'] as ItemId)?.workspace }
    case 'acceptance.link':
    case 'acceptance.waive': {
      const crit = state.criteria.get(p['criterionId'] as string)
      return { create: false, workspace: crit ? item(crit.itemId) : undefined }
    }
    case 'acceptance.run': {
      const ev = state.evidence.get(p['evidenceId'] as string)
      const crit = ev ? state.criteria.get(ev.criterionId) : undefined
      return { create: false, workspace: crit ? item(crit.itemId) : undefined }
    }
    case 'blocker.raise':
      return { create: false, workspace: item(p['targetId']) }
    case 'blocker.resolve': {
      const b = state.blockers.get(p['blockerId'] as string)
      return { create: false, workspace: b ? item(b.targetId) : undefined }
    }
    case 'blocker.resolve-external':
      // Containment is enforced INSIDE resolveExternalDependency (it filters to the channel workspace) —
      // this kind affects N blockers, not one resolvable target, so there is no single workspace to gate here.
      return { create: false, workspace: undefined }
    case 'scope.verification': {
      // Scope §B(c). A wpRef'd run mutates the wpRef ITEM aggregate ⇒ contained by the item's workspace
      // (a W-pinned channel can't record for a V wpRef). A wpRef-absent run lands on the synthetic
      // `verification:<ctx.workspace>` aggregate, built FROM the channel workspace in applyCommand — it
      // can never name a foreign workspace, so there is nothing to gate here (like blocker.resolve-external).
      const wpRef = p['wpRef']
      return { create: false, workspace: wpRef !== undefined ? item(wpRef) : undefined }
    }
  }
}

/**
 * Workspaces of the OTHER aggregates a command affects beyond its primary target. A decision opens a
 * blocker on each of its targets (at create) and resolves/`rejected`-flips them (at outcome), so those
 * target items are mutated too — each must be in the channel's workspace, or a W-pinned channel could
 * reach a V-item by targeting it.
 */
function affectedTargetWorkspaces(cmd: MappedCommand, state: State): Array<string | undefined> {
  const wsOf = (id: ItemId): string | undefined => state.items.get(id)?.workspace
  switch (cmd.kind) {
    case 'decision.create':
      return (cmd.payload['targets'] as string[]).map((t) => wsOf(t as ItemId))
    case 'decision.outcome': {
      const dec = state.decisions.get(cmd.payload['decisionId'] as ItemId)
      return dec ? dec.targets.map((t) => wsOf(t)) : []
    }
    case 'item.reparent': {
      // The NEW parent is mutated-by-reference (it gains a child); a W-pinned channel must not reach a
      // V-parent. Resolved from folded state (undefined ⇒ absent/detach, no containment check needed).
      const parentId = cmd.payload['parentId']
      return parentId !== undefined ? [wsOf(parentId as ItemId)] : []
    }
    default:
      return []
  }
}

/** Channel authorization: capability allowlist, workspace containment, binding-trust. Throws IngestError. */
function authorize(cmd: MappedCommand, ctx: IngestContext, state: State): void {
  if (ctx.allowedKinds && !ctx.allowedKinds.has(cmd.kind)) {
    throw new IngestError(`kind "${cmd.kind}" is not permitted by this channel's capability`)
  }
  const ws = resolveWorkspace(cmd, state)
  if (ws.create) {
    if (ws.workspace !== ctx.workspace) {
      throw new IngestError(
        `${cmd.kind}: payload.workspace "${String(ws.workspace)}" must equal the channel workspace "${ctx.workspace}"`,
      )
    }
  } else if (ws.workspace !== undefined && ws.workspace !== ctx.workspace) {
    throw new IngestError(
      `${cmd.kind}: target belongs to workspace "${ws.workspace}", not the channel workspace "${ctx.workspace}"`,
    )
  }
  // Every additionally-affected target (a decision's targets) must also be contained.
  for (const tw of affectedTargetWorkspaces(cmd, state)) {
    if (tw !== undefined && tw !== ctx.workspace) {
      throw new IngestError(`${cmd.kind}: affects an aggregate in workspace "${tw}", not the channel workspace "${ctx.workspace}"`)
    }
  }
  if (isBinding(cmd) && !BINDING_AUTH.has(ctx.prov.auth)) {
    throw new IngestError(
      `${cmd.kind} is a binding write and requires an authenticated channel (auth="${ctx.prov.auth}")`,
    )
  }
}

/** Typed dispatch to the Track facade. Args were validated/normalized by `mapWorkEvent`. Returns an
 *  assigned id for the creating kinds, else undefined. `ctx` supplies the workspace pin for kinds whose
 *  containment is enforced inside the facade method (e.g. the bulk `blocker.resolve-external`). */
function applyCommand(track: Track, cmd: MappedCommand, ctx: IngestContext): string | undefined {
  const a = cmd.args
  switch (cmd.kind) {
    case 'item.create':
      return track.createItem(a[0] as ItemCreatedPayload)
    case 'item.reparent':
      track.reparentItem(a[0] as ItemId, a[1] as ItemId | undefined)
      return undefined
    case 'item.spec':
      track.setSpec(a[0] as ItemId, a[1] as SpecStatus)
      return undefined
    case 'item.realize':
      track.setRealization(a[0] as ItemId, a[1] as Realization)
      return undefined
    case 'decision.create':
      return track.createDecision(a[0] as DecisionCreatedPayload)
    case 'decision.dossier':
      track.reviseDossier(a[0] as ItemId, a[1] as Dossier)
      return undefined
    case 'decision.add-artifact':
      // The clientToken is already in scope via the ingest seam's withClientToken (do not double-pass).
      track.addDecisionArtifact(a[0] as ItemId, a[1] as DossierArtifact)
      return undefined
    case 'decision.outcome':
      track.setOutcome(a[0] as ItemId, a[1] as Outcome)
      return undefined
    case 'decision.disposition':
      track.setDisposition(a[0] as ItemId, a[1] as Gate, a[2] as Disposition, a[3] as string | undefined)
      return undefined
    case 'acceptance.criterion':
      return track.addCriterion(a[0] as ItemId, a[1] as string)
    case 'acceptance.link':
      return track.linkEvidence(a[0] as string, a[1] as Parameters<Track['linkEvidence']>[1], a[2] as string)
    case 'acceptance.run':
      track.recordRun(a[0] as string, a[1] as { commit: string; env: string; runner: string; result: RunResult })
      return undefined
    case 'acceptance.waive':
      track.waive(a[0] as string, a[1] as string)
      return undefined
    case 'priority.assess':
      track.assessPriority(a[0] as ItemId, a[1] as WsjfInputs)
      return undefined
    case 'blocker.raise':
      return track.openBlocker(a[0] as OpenBlockerInput)
    case 'blocker.resolve':
      track.resolveBlocker(a[0] as string)
      return undefined
    case 'blocker.resolve-external':
      // The channel workspace pins resolution to this workspace's deps (containment, required by type).
      track.resolveExternalDependency(a[0] as string, { workspace: ctx.workspace })
      return undefined
    case 'scope.verification':
      // recordVerification(payload, {workspace}) — the channel workspace pins the synthetic aggregate for a
      // wpRef-absent run; clientToken is already in scope via withClientToken (do not double-pass). Scope §B(c).
      track.recordVerification(a[0] as VerificationRecordedPayload, { workspace: ctx.workspace })
      return undefined
    case 'scope.declare':
      // declareScope(itemId, scope) — the clientToken is already in scope via withClientToken (do not
      // double-pass); the ScopeDecl shape is re-asserted in the facade (assertScopeDecl). Scope §B(a).
      track.declareScope(a[0] as ItemId, a[1] as ScopeDecl)
      return undefined
    case 'item.spec-amend':
      // amendSpec(itemId, amend) — the clientToken is already in scope via withClientToken (do not
      // double-pass); the JsonPatch + baseHash/resultHash shape is re-asserted in the facade
      // (assertSpecAmend) and recorded VERBATIM. M5 (canevas).
      track.amendSpec(a[0] as ItemId, a[1] as SpecAmendPayload)
      return undefined
  }
}

/** The id `applyCommand` originally returned for an event carrying a clientToken (for stable retry ids). */
function resultIdOf(e: TrackEvent): string | null {
  switch (e.type) {
    case 'item.created':
    case 'decision.created':
    case 'blocker.opened':
      return e.aggregateId
    case 'acceptance.criterion.added':
      return (e.payload as { criterionId?: string }).criterionId ?? null
    case 'acceptance.evidence.linked':
      return (e.payload as { evidenceId?: string }).evidenceId ?? null
    default:
      return null
  }
}

/** The workspace of the aggregate a stored event belongs to (for scoping the token index). */
function eventWorkspace(e: TrackEvent, state: State): string | undefined {
  switch (e.aggregate) {
    case 'item':
      return state.items.get(e.aggregateId)?.workspace
    case 'decision':
      return state.decisions.get(e.aggregateId)?.workspace
    case 'blocker': {
      const b = state.blockers.get(e.aggregateId)
      return b ? state.items.get(b.targetId)?.workspace : undefined
    }
    case 'verification':
      // Scope §B(c) — a wpRef-absent run lands on the synthetic `verification:<workspace>` aggregateId, so
      // the workspace is the suffix; a wpRef'd run uses the item aggregate (handled by case 'item' above,
      // never here). Parsing the suffix scopes the token namespace correctly (per-workspace idempotency).
      return e.aggregateId.startsWith('verification:') ? e.aggregateId.slice('verification:'.length) : undefined
  }
}

/**
 * Index clientToken → original result id, from the FIRST (primary) event carrying each token — SCOPED to
 * `workspace`. The namespace is per-workspace so a token used in workspace V cannot suppress (skip) a
 * write on a channel pinned to W, nor disclose V's id to W. (Without this, a shared global namespace would
 * be a cross-tenant write-suppression vector once M3 admits multiple principals onto one log.)
 */
function tokenIndex(events: readonly TrackEvent[], state: State, workspace: string): Map<string, string | null> {
  const idx = new Map<string, string | null>()
  for (const e of events) {
    if (e.clientToken === undefined || idx.has(e.clientToken)) continue
    if (eventWorkspace(e, state) === workspace) idx.set(e.clientToken, resultIdOf(e))
  }
  return idx
}

/**
 * The under-lock idempotency hook ingest injects into `appendCommand`, keyed on `(workspace, clientToken)`
 * — STABLE across a re-minted aggregateId (so a concurrent CREATE-retry, which mints a fresh aggregateId
 * per attempt, still dedups to ONE event). Folds the just-read `existing` log (the SAME fold the
 * `tokenIndex`/`eventWorkspace` fast-path uses), then collects every persisted event carrying this
 * command's `token` whose `eventWorkspace === workspace`, in stream order. Returns that array when
 * non-empty (dedup — append nothing, return the originals verbatim), else `null` (append normally).
 *
 * Workspace is IN the key ⇒ a token used in workspace V can NEVER suppress a write in W (the load-bearing
 * namespacing property). `appendAtomic` is all-or-nothing ⇒ a `(workspace, token)` is present as the whole
 * original command or absent (no partial/superset), so there is nothing to fail-closed on here. Bodies are
 * NOT compared (a retry legitimately re-mints `id`/`at`): `(workspace, clientToken)` is the only stable key.
 */
function workspaceDedupe(token: string, workspace: string): DedupeHook {
  return (_inputs: ReadonlyArray<CommandEvent>, existing: readonly TrackEvent[]): TrackEvent[] | null => {
    const state = fold(existing)
    const original: TrackEvent[] = []
    for (const e of existing) {
      if (e.clientToken === token && eventWorkspace(e, state) === workspace) original.push(e)
    }
    return original.length > 0 ? original : null
  }
}

/**
 * Apply a WorkEvent stream to the store under channel authorization. Each event maps 1:1 to a Track
 * command (its own locked, atomic append).
 *
 * IDEMPOTENCY (v2.3c): a WorkEvent carrying a `clientToken` already present in the log is SKIPPED
 * (nothing applied) and returns its ORIGINAL assigned id — so a retry of a partial/duplicate stream is a
 * safe no-op with stable ids. A WorkEvent WITHOUT a token keeps the at-least-once behavior (re-applies on
 * re-ingest). The skip is single-process-correct (the M2b consumer — a human or sequential CI ingest — is
 * not concurrent); the CONCURRENT-retry race (two parallel ingests both seeing "absent") is deferred to M3
 * (an in-`appendCommand` token recheck under the existing lock + the authenticated channel's request-level
 * idempotency). Note: the loop is still non-atomic (a mid-stream throw leaves earlier events committed),
 * but with tokens a retry skips that committed prefix and resumes.
 */
export function ingest(events: readonly WorkEvent[], ctx: IngestContext, store: EventStore): IngestResult {
  const track = new Track(store, {
    by: ctx.by,
    prov: ctx.prov,
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
    ...(ctx.newId !== undefined ? { newId: ctx.newId } : {}),
  })
  const seen = tokenIndex(store.readAll(), track.state(), ctx.workspace)
  const ids: Array<string | null> = []
  for (const ev of events) {
    const cmd = mapWorkEvent(ev)
    if (cmd.clientToken !== undefined && seen.has(cmd.clientToken)) {
      ids.push(seen.get(cmd.clientToken) ?? null) // already applied — skip, return the original id
      continue
    }
    authorize(cmd, ctx, track.state()) // fresh fold each iteration (re-fold after each apply)
    // Pass the workspace-scoped under-lock dedupe hook ONLY for a tokened command — keyed on
    // (workspace, clientToken), stable across a re-minted aggregateId, so a concurrent create-retry that
    // defeated the fast-path dedups to ONE event under the store lock. A tokenless command passes no hook
    // (the store would have no key) and keeps the at-least-once behavior.
    const dedupeOpt = cmd.clientToken !== undefined ? { dedupe: workspaceDedupe(cmd.clientToken, ctx.workspace) } : {}
    const id = track.withClientToken(cmd.clientToken, () => applyCommand(track, cmd, ctx), dedupeOpt) ?? null
    if (cmd.clientToken !== undefined) seen.set(cmd.clientToken, id) // intra-stream duplicates also skip
    ids.push(id)
  }
  return { ids, count: events.length }
}
