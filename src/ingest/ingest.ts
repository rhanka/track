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
import type { Dossier, Outcome } from '../model/decision.js'
import type { Disposition, Gate, ItemId, Realization, SpecStatus } from '../model/item.js'
import type { ItemCreatedPayload } from '../model/item.js'
import type { DecisionCreatedPayload } from '../model/decision.js'
import type { WsjfInputs } from '../model/priority.js'
import type { ActorId, Provenance, Ulid } from '../events/types.js'
import type { EventStore } from '../events/store.js'
import type { State } from '../state/fold.js'
import { Track, type OpenBlockerInput } from '../track.js'
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
    case 'item.spec':
    case 'acceptance.criterion':
    case 'priority.assess':
    case 'decision.disposition':
      return { create: false, workspace: item(p['itemId']) }
    case 'decision.outcome':
    case 'decision.dossier':
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
 *  assigned id for the creating kinds, else undefined. */
function applyCommand(track: Track, cmd: MappedCommand): string | undefined {
  const a = cmd.args
  switch (cmd.kind) {
    case 'item.create':
      return track.createItem(a[0] as ItemCreatedPayload)
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
  }
}

/**
 * Apply a WorkEvent stream to the store under channel authorization. Each event maps 1:1 to a Track
 * command (its own locked, atomic append).
 *
 * ⚠️ AT-LEAST-ONCE, NON-ATOMIC (M2b). The loop has no batch transaction: if event k throws
 * (Ingest/DomainError), events 1..k-1 are already committed. And re-ingesting re-applies create kinds
 * (no `sourceKey` dedup — only `importBranch` dedups), so a retry after a partial/timed-out batch
 * DUPLICATES every already-applied create. Safe for a human running `track ingest` and reviewing the
 * result; a RETRYING consumer (CI/harness) MUST dedup upstream. Do NOT wire an automated-retry M3
 * channel onto this without first implementing idempotency (the reserved envelope key, or sourceKey-based
 * create dedup).
 */
export function ingest(events: readonly WorkEvent[], ctx: IngestContext, store: EventStore): IngestResult {
  const track = new Track(store, {
    by: ctx.by,
    prov: ctx.prov,
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
    ...(ctx.newId !== undefined ? { newId: ctx.newId } : {}),
  })
  const ids: Array<string | null> = []
  for (const ev of events) {
    const cmd = mapWorkEvent(ev)
    authorize(cmd, ctx, track.state()) // fresh fold each iteration (re-fold after each apply)
    ids.push(applyCommand(track, cmd) ?? null)
  }
  return { ids, count: events.length }
}
