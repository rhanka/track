import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { Track } from '../track.js'
import { auditFindings, type AuditFinding } from './audit.js'

// Lot 2 (DESIGN R4) — `track audit` = a SEPARATE deterministic AuditFinding[] producer (NOT inlined in
// buildDirectives). Findings: orphan (action), empty-wp, duplicate, cross-workspace-subtree (INFO),
// singleton-workspace (INFO). NO fuzzy naming heuristic (C7 cut). The orphan hand-off routes via the plan
// flow — assertSafeCommandHint forbids hinting `reparent`, so the audit can NEVER hint its own fix.

let dir: string
let seq = 0
function trackAt(): Track {
  return new Track(new EventStore(join(dir, '.track', 'events.jsonl')), {
    by: 'tester',
    now: () => '2026-06-29T00:00:00.000Z',
    newId: () => `id-${String(++seq).padStart(4, '0')}`,
  })
}
const find = (fs: AuditFinding[], kind: AuditFinding['kind']): AuditFinding[] => fs.filter((f) => f.kind === kind)

beforeEach(() => {
  seq = 0
  dir = mkdtempSync(join(tmpdir(), 'track-audit-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A multi-workspace fixture exercising every deterministic finding kind. */
function fixture(t: Track): Record<string, string> {
  // Workspace A — a WP with leaves (incl. an exact duplicate pair) + one ORPHAN open leaf.
  const wpA = t.createItem({ kind: 'chore', title: 'WP-A', workspace: 'A', role: 'workpackage' })
  const leafA1 = t.createItem({ kind: 'chore', title: 'a1', workspace: 'A', parentId: wpA })
  const dup1 = t.createItem({ kind: 'chore', title: 'Dup', workspace: 'A', parentId: wpA })
  const dup2 = t.createItem({ kind: 'chore', title: 'Dup', workspace: 'A', parentId: wpA })
  const orphanA = t.createItem({ kind: 'chore', title: 'lonely', workspace: 'A' }) // open, parentless, no WP ancestor
  // Workspace B — an EMPTY workpackage (also B's only item ⇒ a singleton workspace).
  const wpB = t.createItem({ kind: 'chore', title: 'WP-B', workspace: 'B', role: 'workpackage' })
  // Workspace C — a single non-WP item ⇒ singleton; C has NO WP so its parentless item is NOT an orphan.
  const lc = t.createItem({ kind: 'chore', title: 'c', workspace: 'C' })
  // Workspaces X+Y — a WP rooted in X holding X and Y leaves ⇒ a cross-workspace subtree.
  const wpX = t.createItem({ kind: 'chore', title: 'WP-X', workspace: 'X', role: 'workpackage' })
  const leafX = t.createItem({ kind: 'chore', title: 'x', workspace: 'X', parentId: wpX })
  const leafY = t.createItem({ kind: 'chore', title: 'y1', workspace: 'Y', parentId: wpX })
  const leafY2 = t.createItem({ kind: 'chore', title: 'y2', workspace: 'Y', parentId: wpX })
  return { wpA, leafA1, dup1, dup2, orphanA, wpB, lc, wpX, leafX, leafY, leafY2 }
}

describe('auditFindings — deterministic structural findings', () => {
  it('flags the orphan (open leaf, no WP ancestor, workspace uses WPs) as the ONLY orphan', () => {
    const t = trackAt()
    const ids = fixture(t)
    const orphans = find(auditFindings(t.state()), 'orphan')
    expect(orphans.length).toBe(1)
    expect(orphans[0]!.itemId).toBe(ids['orphanA'])
    expect(orphans[0]!.severity).toBe('action')
  })

  it('does NOT flag a parentless open item as orphan in a workspace with NO workpackage', () => {
    const t = trackAt()
    t.createItem({ kind: 'chore', title: 'free', workspace: 'D' }) // D has no WP ⇒ no orphan
    expect(find(auditFindings(t.state()), 'orphan')).toEqual([])
  })

  it('flags the empty workpackage', () => {
    const t = trackAt()
    const ids = fixture(t)
    const empty = find(auditFindings(t.state()), 'empty-wp')
    expect(empty.map((f) => f.itemId)).toEqual([ids['wpB']])
  })

  it('flags the exact (title,kind,workspace) duplicate group', () => {
    const t = trackAt()
    const ids = fixture(t)
    const dups = find(auditFindings(t.state()), 'duplicate')
    expect(dups.length).toBe(1)
    expect([...dups[0]!.itemIds!].sort()).toEqual([ids['dup1'], ids['dup2']].sort())
  })

  it('flags the cross-workspace subtree as INFO (chiffré, non-actionable)', () => {
    const t = trackAt()
    const ids = fixture(t)
    const xs = find(auditFindings(t.state()), 'cross-workspace-subtree')
    expect(xs.length).toBe(1)
    expect(xs[0]!.wpRootId).toBe(ids['wpX'])
    expect(xs[0]!.severity).toBe('info')
    expect([...xs[0]!.workspaces!].sort()).toEqual(['X', 'Y'])
  })

  it('flags singleton workspaces as INFO (B and C each hold exactly one item)', () => {
    const t = trackAt()
    fixture(t)
    const singles = find(auditFindings(t.state()), 'singleton-workspace')
    expect(singles.every((f) => f.severity === 'info')).toBe(true)
    expect(singles.map((f) => f.workspace).sort()).toEqual(['B', 'C'])
  })

  it('is DETERMINISTIC — two runs over the same state are deep-equal', () => {
    const t = trackAt()
    fixture(t)
    const a = auditFindings(t.state())
    const b = auditFindings(t.state())
    expect(a).toEqual(b)
  })

  it('an empty state yields no findings', () => {
    const t = trackAt()
    expect(auditFindings(t.state())).toEqual([])
  })
})
