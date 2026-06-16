import type { ActorId, Ulid } from '../events/types.js'
import type { PriorityAssessment } from './priority.js'

export type ItemId = Ulid
export type BlockerId = Ulid

export type ItemKind = 'feature' | 'bug' | 'chore' | 'decision'
/**
 * An optional, additive container marker (Workpackages design §2; Scope §B(a)). A workpackage is
 * `kind:'chore'` + `role:'workpackage'` — WP-ness comes ONLY from this field, never inferred from kind,
 * children, a `wp:` sourceKey, or a link. A `'spec-phase'` is a finer container nested under a WP or
 * spec-phase (labels derive from tree position; the rollup descends through it like a WP). Both are
 * orthogonal/optional like `accountable`/`engagementRef` ⇒ zero hash change, explicit, queryable,
 * rename-stable. (A durable public `code?` label is deferred.)
 */
export type ItemRole = 'workpackage' | 'spec-phase'

/**
 * Scope §B(a) — a declarative scope on a WP/spec-phase: INERT path globs (track stores the strings,
 * NEVER matches them — the harness reads them to compute the path verdict). Additive/optional on
 * ItemState + ItemCreatedPayload; set/replaced by a `scope.declare` WorkEvent → `scope.declared` event.
 */
export interface ScopeDecl {
  allowed?: string[]
  forbidden?: string[]
  conditional?: string[]
}
export type SpecStatus = 'to-specify' | 'specified'
export type Realization = 'to-do' | 'in-progress' | 'done' | 'cancelled' | 'rejected'

// Decision gates an Item passes (SPEC §2.10). `Gate` doubles as a Decision's `decisionKind`.
export type Gate = 'orientation' | 'commitment'
export type Disposition = 'required' | 'skipped' | 'not-applicable' | 'completed'

export interface Link {
  kind: string
  locator: string
}

/** A realization → `rejected` is the consequence of a `no-go` Decision (SPEC §2.3, §2.6). */
export interface RealizationCause {
  decisionId: ItemId
}

export interface ItemState {
  id: ItemId
  kind: ItemKind
  title: string
  workspace: string
  specStatus: SpecStatus | 'n/a' // `n/a` for kind:"decision" (SPEC §2.2)
  realization: Realization
  disposition: Record<Gate, Disposition> // per-gate disposition (SPEC §2.10)
  priority?: PriorityAssessment // latest assessment, live sort key (SPEC §2.8)
  parentId?: ItemId
  role?: ItemRole // additive container marker (Workpackages §2); present ⇒ a workpackage / spec-phase
  scope?: ScopeDecl // Scope §B(a) — declarative INERT path globs on a WP/spec-phase (track never matches)
  sourceKey?: string
  body?: string
  links?: Link[]
  // RACI (Lot A, additive): WHO is answerable/doing — domain data about the work, distinct from
  // the event writer `by` (which the ingest seam pins to the channel). `engagementRef` links to an
  // h2a ENGAGEMENT (the executable contract); present ⇒ a contract exists. track records, never owns it.
  accountable?: ActorId // RACI-A — the single neck-to-grab
  responsible?: ActorId[] // RACI-R — the doers
  engagementRef?: string
  /**
   * Acceptance-freshness lifecycle — the item's realization ANCHOR commit (the SHA its work landed at, or
   * the merge commit after consolidation). A READ-ONLY DETAIL the freshness projection consumes (run-SHA vs
   * anchor-SHA); it does NOT touch AcceptanceStatus/buckets/gates (those stay strict-against-baselineCommit).
   * Set by the `realization.anchored` event (LAST-write-wins); absent ⇒ no anchor (fall back to baseline).
   */
  realizedCommit?: string
}

/**
 * Scope §B(a) — is this item a CONTAINER node (a `workpackage` or `spec-phase`), i.e. not a flat leaf?
 * The rollup descends through both and excludes both from leaf counts / the flat buckets. Centralized so
 * rollup/status/report/read all share ONE definition of "container vs leaf".
 */
export function isRoleContainer(item: { role?: ItemRole }): boolean {
  return item.role === 'workpackage' || item.role === 'spec-phase'
}

export interface ItemCreatedPayload {
  kind: ItemKind
  title: string
  workspace: string
  parentId?: ItemId
  role?: ItemRole
  scope?: ScopeDecl // Scope §B(a) — INERT path globs on a WP/spec-phase
  sourceKey?: string
  body?: string
  links?: Link[]
  accountable?: ActorId
  responsible?: ActorId[]
  engagementRef?: string
}

/** A rejected domain command (illegal transition, unknown aggregate, …). */
export class DomainError extends Error {
  override name = 'DomainError'
}

/**
 * Scope §B(a) — the role nesting invariant, checked by createItem/reparentItem BEFORE any append:
 *   - a `'workpackage'` nests only under a `'workpackage'`;
 *   - a `'spec-phase'` nests only under a `'workpackage'` or `'spec-phase'`;
 *   - a non-role leaf nests under anything (unchanged back-compat).
 * `childRole` is the moving/created item's role; `parentRole` the prospective parent's role (undefined
 * when the parent has no role, i.e. a plain leaf/feature container). Throws DomainError on violation.
 * `childId`/`parentId` are only for the message.
 */
export function assertRoleNesting(
  childRole: ItemRole | undefined,
  parentRole: ItemRole | undefined,
  childId: ItemId,
  parentId: ItemId,
): void {
  if (childRole === 'workpackage' && parentRole !== 'workpackage') {
    throw new DomainError(
      `cannot nest workpackage ${childId} under ${parentId}: a workpackage may only nest under a workpackage (Scope §B(a))`,
    )
  }
  if (childRole === 'spec-phase' && parentRole !== 'workpackage' && parentRole !== 'spec-phase') {
    throw new DomainError(
      `cannot nest spec-phase ${childId} under ${parentId}: a spec-phase may only nest under a workpackage or spec-phase (Scope §B(a))`,
    )
  }
}

/**
 * Scope §B(a) — fail-closed validation of a ScopeDecl payload (mirrors assertVerificationRun). The
 * envelope schema checks each field is a `string[]`; this re-asserts that AND normalizes (drops absent
 * optionals so the recorded shape is minimal + hash-stable). track stores the strings, NEVER matches them.
 */
export function assertScopeDecl(input: unknown): ScopeDecl {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DomainError('scope.declare: scope must be an object')
  }
  const a = input as Record<string, unknown>
  const list = (key: string): string[] | undefined => {
    const v = a[key]
    if (v === undefined) return undefined
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      throw new DomainError(`scope.declare: ${key} must be a string[]`)
    }
    return v as string[]
  }
  const allowed = list('allowed')
  const forbidden = list('forbidden')
  const conditional = list('conditional')
  return {
    ...(allowed !== undefined ? { allowed } : {}),
    ...(forbidden !== undefined ? { forbidden } : {}),
    ...(conditional !== undefined ? { conditional } : {}),
  }
}

// Spec axis is monotone: `to-specify → specified` once; reverse rejected (SPEC §2.2).
const SPEC_TRANSITIONS: Record<SpecStatus, ReadonlyArray<SpecStatus>> = {
  'to-specify': ['specified'],
  specified: [],
}

// Realization forward transitions (SPEC §2.3). `rejected` is handled separately — it is only
// reachable from a `no-go` Decision (with a cause), never a manual transition.
const REALIZATION_TRANSITIONS: Record<Realization, ReadonlyArray<Realization>> = {
  'to-do': ['in-progress', 'cancelled'],
  'in-progress': ['done', 'cancelled'],
  done: [],
  cancelled: [],
  rejected: [],
}

export function assertSpecTransition(item: ItemState, to: SpecStatus): void {
  if (item.specStatus === 'n/a') {
    throw new DomainError(`spec axis is n/a for ${item.kind} item ${item.id}`)
  }
  if (!SPEC_TRANSITIONS[item.specStatus].includes(to)) {
    throw new DomainError(`illegal spec transition ${item.specStatus} -> ${to} (item ${item.id})`)
  }
}

export function assertRealizationTransition(
  item: { id: ItemId; realization: Realization }, // ItemState or DecisionState — both have realization
  to: Realization,
  hasCause: boolean,
): void {
  if (to === 'rejected') {
    if (!hasCause) {
      throw new DomainError(`realization -> rejected requires a decision cause (item ${item.id})`)
    }
    if (item.realization !== 'to-do' && item.realization !== 'in-progress') {
      throw new DomainError(
        `illegal realization transition ${item.realization} -> rejected (item ${item.id})`,
      )
    }
    return
  }
  if (!REALIZATION_TRANSITIONS[item.realization].includes(to)) {
    throw new DomainError(
      `illegal realization transition ${item.realization} -> ${to} (item ${item.id})`,
    )
  }
}
