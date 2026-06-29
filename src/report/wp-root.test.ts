import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { Track } from '../track.js'
import { wpRootId } from './rollup.js'

// Lot 1 (DESIGN R1) — wpRootId DERIVED: the HIGHEST ancestor with `role === 'workpackage'` STRICT (NOT
// isRoleContainer — a spec-phase is NEVER a wpRoot), walking parentId. Nested sub-WPs ⇒ the topmost wins.

let dir: string
let seq = 0
function trackAt(): Track {
  return new Track(new EventStore(join(dir, '.track', 'events.jsonl')), {
    by: 'tester',
    now: () => '2026-06-29T00:00:00.000Z',
    newId: () => `id-${String(++seq).padStart(4, '0')}`,
  })
}

beforeEach(() => {
  seq = 0
  dir = mkdtempSync(join(tmpdir(), 'track-wproot-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('wpRootId — strict workpackage, highest ancestor', () => {
  it('returns the WP for a leaf directly under a workpackage', () => {
    const t = trackAt()
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const leaf = t.createItem({ kind: 'chore', title: 'l', workspace: 'ws', parentId: wp })
    expect(wpRootId(t.state().items, leaf)).toBe(wp)
  })

  it('returns the TOPMOST workpackage for nested sub-WPs (highest wins)', () => {
    const t = trackAt()
    const top = t.createItem({ kind: 'chore', title: 'top', workspace: 'ws', role: 'workpackage' })
    const sub = t.createItem({ kind: 'chore', title: 'sub', workspace: 'ws', role: 'workpackage', parentId: top })
    const leaf = t.createItem({ kind: 'chore', title: 'l', workspace: 'ws', parentId: sub })
    expect(wpRootId(t.state().items, leaf)).toBe(top)
    expect(wpRootId(t.state().items, sub)).toBe(top)
    expect(wpRootId(t.state().items, top)).toBe(top) // a top WP with no WP parent is its OWN root
  })

  it('SKIPS spec-phase containers — a spec-phase is NEVER a wpRoot (strict workpackage)', () => {
    const t = trackAt()
    const wp = t.createItem({ kind: 'chore', title: 'WP', workspace: 'ws', role: 'workpackage' })
    const phase = t.createItem({ kind: 'chore', title: 'phase', workspace: 'ws', role: 'spec-phase', parentId: wp })
    const leaf = t.createItem({ kind: 'chore', title: 'l', workspace: 'ws', parentId: phase })
    expect(wpRootId(t.state().items, leaf)).toBe(wp) // the WP above the spec-phase, never the spec-phase
  })

  it('a spec-phase with NO workpackage ancestor has NO wpRoot (strict)', () => {
    const t = trackAt()
    // (constructed directly; role-nesting normally forbids a parentless spec-phase, but the derivation must
    // be defensive regardless of how the tree got there.)
    const phase = t.createItem({ kind: 'chore', title: 'phase', workspace: 'ws', role: 'spec-phase' })
    const leaf = t.createItem({ kind: 'chore', title: 'l', workspace: 'ws', parentId: phase })
    expect(wpRootId(t.state().items, leaf)).toBeUndefined()
  })

  it('returns undefined for a leaf with no workpackage ancestor', () => {
    const t = trackAt()
    const a = t.createItem({ kind: 'chore', title: 'a', workspace: 'ws' })
    const b = t.createItem({ kind: 'chore', title: 'b', workspace: 'ws', parentId: a })
    expect(wpRootId(t.state().items, b)).toBeUndefined()
    expect(wpRootId(t.state().items, a)).toBeUndefined()
  })

  it('returns undefined for an unknown item', () => {
    const t = trackAt()
    expect(wpRootId(t.state().items, 'nope')).toBeUndefined()
  })
})
