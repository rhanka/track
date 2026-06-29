// DESIGN R4 (Lot 2) — `track audit` = a SEPARATE, DETERMINISTIC `AuditFinding[]` producer. NOT inlined in
// `buildDirectives` (which emits one WORK directive per WP node). Findings are STRUCTURAL facts derived
// purely from folded state — NO fuzzy naming heuristic (C7 cut as locale-sensitive noise). The actionable
// `orphan` hand-off routes via the PLAN flow, never a `commandHint`: `assertSafeCommandHint` forbids hinting
// `reparent`, so the audit can never hint its own fix (the reuse is the guard).

import { isRoleContainer, type ItemId, type ItemState } from '../model/item.js'
import type { State } from '../state/fold.js'
import { assertSafeCommandHint } from './directive.js'
import { wpRootId } from './rollup.js'

export type AuditFindingKind =
  | 'orphan'
  | 'empty-wp'
  | 'duplicate'
  | 'cross-workspace-subtree'
  | 'singleton-workspace'

/** `action` = a finding the plan flow should resolve; `info` = an expected/structural observation. */
export type AuditSeverity = 'action' | 'info'

export interface AuditFinding {
  kind: AuditFindingKind
  severity: AuditSeverity
  detail: string
  workspace?: string
  /** Single subject (orphan, empty-wp). */
  itemId?: ItemId
  /** A group (duplicate). */
  itemIds?: ItemId[]
  /** The top workpackage of a cross-workspace subtree. */
  wpRootId?: ItemId
  /** The distinct workspaces a cross-workspace subtree spans. */
  workspaces?: string[]
  /** Record-only, `assertSafeCommandHint`-guarded. NEVER a `reparent` (the fix routes via the plan flow). */
  commandHint?: string
}

const KIND_ORDER: Record<AuditFindingKind, number> = {
  orphan: 0,
  'empty-wp': 1,
  duplicate: 2,
  'cross-workspace-subtree': 3,
  'singleton-workspace': 4,
}

/** A stable sort key so two runs over the same state are byte-identical (determinism is the contract). */
function sortKey(f: AuditFinding): string {
  const primary = f.itemId ?? f.wpRootId ?? f.itemIds?.[0] ?? f.workspace ?? ''
  return `${KIND_ORDER[f.kind]}:${f.workspace ?? ''}:${primary}`
}

const isOpen = (i: ItemState): boolean => i.realization === 'to-do' || i.realization === 'in-progress'

/**
 * Produce the deterministic structural findings for the folded state. PURE; no clock, no I/O. The findings
 * are sorted by (kind, workspace, primary id) so the output never flickers.
 */
export function auditFindings(state: State): AuditFinding[] {
  const items = state.items
  const all = [...items.values()]
  const findings: AuditFinding[] = []

  // children index for transitive leaf walks.
  const childrenOf = new Map<ItemId | undefined, ItemState[]>()
  for (const item of all) {
    const list = childrenOf.get(item.parentId) ?? []
    list.push(item)
    childrenOf.set(item.parentId, list)
  }
  // Transitive TRUE leaves (non-container, no children) under a root — their workspaces, and the count.
  const transitiveLeaves = (rootId: ItemId): { count: number; workspaces: Set<string> } => {
    const workspaces = new Set<string>()
    let count = 0
    const walk = (id: ItemId): void => {
      for (const child of childrenOf.get(id) ?? []) {
        const kids = childrenOf.get(child.id) ?? []
        if (!isRoleContainer(child) && kids.length === 0) {
          count++
          workspaces.add(child.workspace)
        } else {
          walk(child.id) // descend through a container OR a non-leaf non-container
        }
      }
    }
    walk(rootId)
    return { count, workspaces }
  }

  // Which workspaces contain ≥1 workpackage (an orphan is meaningful only where WP structure is expected).
  const workspacesWithWp = new Set<string>()
  for (const i of all) if (i.role === 'workpackage') workspacesWithWp.add(i.workspace)

  // items per workspace (singleton detection).
  const perWorkspace = new Map<string, number>()
  for (const i of all) perWorkspace.set(i.workspace, (perWorkspace.get(i.workspace) ?? 0) + 1)

  // --- orphan: an OPEN, non-container leaf with no workpackage ancestor, in a WP-using workspace ---
  for (const i of all) {
    if (i.role !== undefined) continue // a container is never an orphan
    if (!isOpen(i)) continue
    if (!workspacesWithWp.has(i.workspace)) continue // no WP here ⇒ a top-level item is legitimate, not orphan
    if (wpRootId(items, i.id) !== undefined) continue // has a WP ancestor ⇒ homed
    findings.push({ kind: 'orphan', severity: 'action', itemId: i.id, workspace: i.workspace, detail: `open item "${i.title}" has no workpackage ancestor` })
  }

  // --- empty-wp / cross-workspace-subtree (per workpackage) ---
  for (const wp of all) {
    if (wp.role !== 'workpackage') continue
    const { count, workspaces } = transitiveLeaves(wp.id)
    if (count === 0) {
      findings.push({ kind: 'empty-wp', severity: 'action', itemId: wp.id, workspace: wp.workspace, detail: `workpackage "${wp.title}" has no leaf` })
    }
    // cross-workspace-subtree is reported once, on the TOP workpackage of the subtree (avoid sub-WP duplicates).
    if (workspaces.size > 1 && wpRootId(items, wp.id) === wp.id) {
      findings.push({
        kind: 'cross-workspace-subtree',
        severity: 'info',
        wpRootId: wp.id,
        workspace: wp.workspace,
        workspaces: [...workspaces].sort(),
        detail: `workpackage "${wp.title}" spans workspaces ${[...workspaces].sort().join(', ')}`,
      })
    }
  }

  // --- duplicate: exact (title, kind, workspace) ---
  const byTuple = new Map<string, ItemState[]>()
  for (const i of all) {
    const key = JSON.stringify([i.title, i.kind, i.workspace])
    const list = byTuple.get(key) ?? []
    list.push(i)
    byTuple.set(key, list)
  }
  for (const group of byTuple.values()) {
    if (group.length < 2) continue
    const itemIds = group.map((g) => g.id).sort()
    findings.push({ kind: 'duplicate', severity: 'action', itemIds, workspace: group[0]!.workspace, detail: `${group.length}× exact duplicate "${group[0]!.title}" (${group[0]!.kind})` })
  }

  // --- singleton-workspace (INFO: a new workspace legitimately starts at 1 item) ---
  for (const [workspace, n] of perWorkspace) {
    if (n === 1) findings.push({ kind: 'singleton-workspace', severity: 'info', workspace, detail: `workspace "${workspace}" holds a single item` })
  }

  for (const f of findings) assertSafeCommandHint(f.commandHint) // reuse the record-only allowlist guard
  return findings.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
}
