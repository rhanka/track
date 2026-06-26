import type { WorkEventKind } from './contract.js'

/**
 * Focus L4 / canevas host action identifiers.
 *
 * These are NOT new Track event kinds. They are the small, stable action vocabulary a Focus/Canevas
 * host can bind to the already-versioned WorkEvent ingest contract. The host still constructs and
 * submits ordinary WorkEvents through `ingest(context,event,store)`; this table prevents UI prose from
 * becoming the contract.
 */
export const FOCUS_L4_ACTIONS = ['ratifyOutcome', 'amendSpec', 'addDossierArtifact'] as const
export type FocusL4Action = (typeof FOCUS_L4_ACTIONS)[number]

export type FocusL4Aggregate = 'decision' | 'item'

export interface FocusL4ActionBinding {
  /** Host/canevas gesture. */
  action: FocusL4Action
  /** The WorkEvent kind to submit through @sentropic/track/ingest. */
  workEventKind: WorkEventKind
  /** Binding writes require IngestContext.prov.auth ∈ BINDING_AUTH (`local-user` or `signed`). */
  requiresBindingAuth: true
  /** Aggregate the action mutates. */
  aggregate: FocusL4Aggregate
  /** Required payload fields on the WorkEvent envelope. */
  requiredPayload: readonly string[]
  /** Human-readable purpose for host affordance labels and docs. */
  summary: string
}

export const FOCUS_L4_ACTION_BINDINGS: Readonly<Record<FocusL4Action, FocusL4ActionBinding>> = Object.freeze({
  ratifyOutcome: Object.freeze({
    action: 'ratifyOutcome',
    workEventKind: 'decision.outcome',
    requiresBindingAuth: true,
    aggregate: 'decision',
    requiredPayload: Object.freeze(['decisionId', 'to']),
    summary: 'Ratify a decision outcome by appending decision.outcome.',
  }),
  amendSpec: Object.freeze({
    action: 'amendSpec',
    workEventKind: 'item.spec-amend',
    requiresBindingAuth: true,
    aggregate: 'item',
    requiredPayload: Object.freeze(['itemId', 'patch']),
    summary: 'Record an owner-approved live spec amendment by appending spec.amended.',
  }),
  addDossierArtifact: Object.freeze({
    action: 'addDossierArtifact',
    workEventKind: 'decision.add-artifact',
    requiresBindingAuth: true,
    aggregate: 'decision',
    requiredPayload: Object.freeze(['decisionId', 'artifact']),
    summary: 'Attach a dossier artifact by appending decision.artifact-added.',
  }),
})

export function focusL4ActionBinding(action: FocusL4Action): FocusL4ActionBinding {
  return FOCUS_L4_ACTION_BINDINGS[action]
}
