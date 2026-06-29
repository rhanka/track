// preconisation-actionnable (DESIGN §9) — the directive selector test plan. Proves the grief is fixed:
// each WP yields a directive DERIVED from real state (no more one constant phrase), langue-neutre, and
// delegable. STRICT TDD over the pure `buildDirectives` + the `view` derivation.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { Track } from '../track.js'
import type { DecisionRow } from './build.js'
import { assertSafeCommandHint, buildDirectives, dispatchQueueOf, type Directive } from './directive.js'
import { buildWpConductorView, directivePhrase } from './format.js'
import { computeWpTree } from './rollup.js'

const now = (): string => '2026-06-09T00:00:00.000Z'
const cfg = { baselineCommit: 'c1', requireAccepted: false }

let dir: string
let t: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-directive-'))
  t = new Track(new EventStore(join(dir, '.track', 'events.jsonl')), { by: 'human:x', now })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// ---- builders -------------------------------------------------------------------------------------
const wp = (title: string): string => t.createItem({ kind: 'chore', title, workspace: 'ws', role: 'workpackage' })
const leaf = (title: string, parentId: string, kind: 'chore' | 'feature' = 'chore'): string =>
  t.createItem({ kind, title, workspace: 'ws', parentId })

/** A specified, to-do leaf (no spec gate). */
const specified = (id: string): string => {
  t.setSpec(id, 'specified')
  return id
}
/** A done leaf whose only recorded run is at a non-baseline commit ⇒ acceptance STALE (invisible debt). */
const staleDone = (id: string): string => {
  const ev = t.linkEvidence(t.addCriterion(id, 'crit'), 'unit', 'loc')
  t.recordRun(ev, { commit: 'c0', env: 'ci', runner: 'v', result: 'pass' }) // c0 ≠ baseline c1 ⇒ stale
  t.setRealization(id, 'in-progress')
  t.setRealization(id, 'done')
  return id
}
/** A to-do leaf whose acceptance is FAIL (a live failing run at baseline). */
const failing = (id: string): string => {
  const ev = t.linkEvidence(t.addCriterion(id, 'crit'), 'unit', 'loc')
  t.recordRun(ev, { commit: 'c1', env: 'ci', runner: 'v', result: 'fail' })
  return id
}

const directives = (decisions: DecisionRow[] = []): Directive[] => buildDirectives(computeWpTree(t.state(), cfg), decisions)
const stepCodes = (ds: Directive[]): string[] => ds.map((d) => d.step.code)

// ---- 1. six WPs ⇒ six DISTINCT directives (the grief: no more identical constant line) ------------

describe('directive selector — distinctness (DESIGN §9, grief regression)', () => {
  it('6 WPs in 6 distinct states ⇒ 6 directives with 6 distinct steps and 6 distinct phrases', () => {
    staleDone(leaf('stale', wp('WP1')))
    failing(leaf('fail', wp('WP2')))
    t.setRealization(specified(leaf('wip', wp('WP3'))), 'in-progress')
    t.assessPriority(specified(leaf('valued', wp('WP4'))), {
      userBusinessValue: 5,
      timeCriticality: 3,
      riskReductionOpportunityEnablement: 2,
      jobSize: 1,
    })
    leaf('needs-spec', wp('WP5')) // default specStatus 'to-specify' ⇒ spec gate
    specified(leaf('unprioritized', wp('WP6'))) // lone specified to-do, no WSJF ⇒ prioritize-backlog

    const ds = directives()
    expect(ds).toHaveLength(6)
    expect(new Set(stepCodes(ds))).toEqual(
      new Set(['rerun-acceptance', 'fix-acceptance', 'finish-increment', 'start-increment', 'amend-spec', 'prioritize-backlog']),
    )
    // The rendered préconisations are PAIRWISE DISTINCT (the actual grief: identical lines).
    const phrases = ds.map(directivePhrase)
    expect(new Set(phrases).size).toBe(6)
  })

  it('renders 6 distinct préconisations in the DÉCISIONS/ACTIONS table (no constant column)', () => {
    staleDone(leaf('stale', wp('WP1')))
    failing(leaf('fail', wp('WP2')))
    t.setRealization(specified(leaf('wip', wp('WP3'))), 'in-progress')
    leaf('needs-spec', wp('WP4'))
    specified(leaf('unprioritized', wp('WP5')))
    t.assessPriority(specified(leaf('valued', wp('WP6'))), { userBusinessValue: 5, timeCriticality: 1, riskReductionOpportunityEnablement: 1, jobSize: 1 })

    const view = buildWpConductorView(computeWpTree(t.state(), cfg))
    const recos = view.tables.find((tb) => tb.id === 'decisions-actions')!.rows.map((r) => r['recommendation'])
    expect(new Set(recos).size).toBe(recos.length) // all distinct — no constant préconisation
  })
})

// ---- 2. done + acceptance stale (requireAccepted=false) ⇒ rerun-acceptance with target.id ----------

describe('directive selector — invisible acceptance debt (DESIGN §2 scope)', () => {
  it('a DONE leaf with stale acceptance ⇒ a rerun-acceptance directive carrying its target.id', () => {
    const id = staleDone(leaf('done-but-stale', wp('WP1')))
    const [d] = directives()
    expect(d!.step.code).toBe('rerun-acceptance')
    expect(d!.target.id).toBe(id)
    expect(d!.target.kind).toBe('item')
    expect(d!.rank).toBe('P2_ACCEPTANCE')
    expect(d!.gate?.code).toBe('acceptance-stale')
    expect(d!.facts.bucket).toBe('DONE') // requireAccepted=false ⇒ it IS in DONE, yet still surfaced
    expect(d!.facts.acceptance).toBe('stale')
  })

  it('acceptance unknown/waived/n-a on a DONE leaf does NOT emit a rerun (nothing to re-run)', () => {
    staleDone(leaf('stale', wp('WP1')))
    const w2 = wp('WP2')
    const plainDone = leaf('done-unknown', w2) // no criteria ⇒ acceptance 'unknown'
    t.setRealization(plainDone, 'in-progress')
    t.setRealization(plainDone, 'done')
    const ds = directives()
    // Only the stale WP1 leaf yields a directive; the unknown-acceptance done leaf is out of scope.
    expect(ds.map((d) => d.target.title)).toEqual(['stale'])
  })
})

// ---- 3. urgency precedence: fail > in-progress > stale; in-progress > to-do ------------------------

describe('directive selector — urgency precedence (DESIGN §2.B)', () => {
  it('acceptance fail primes in-progress within a WP', () => {
    const w = wp('WP1')
    failing(leaf('fail-leaf', w))
    t.setRealization(specified(leaf('wip-leaf', w)), 'in-progress')
    const work = directives().filter((d) => d.mode === 'subagent')
    expect(work).toHaveLength(1)
    expect(work[0]!.step.code).toBe('fix-acceptance')
    expect(work[0]!.target.title).toBe('fail-leaf')
  })

  it('in-progress primes acceptance stale within a WP', () => {
    const w = wp('WP1')
    staleDone(leaf('stale-leaf', w))
    t.setRealization(specified(leaf('wip-leaf', w)), 'in-progress')
    const work = directives().filter((d) => d.mode === 'subagent')
    expect(work).toHaveLength(1)
    expect(work[0]!.step.code).toBe('finish-increment')
    expect(work[0]!.target.title).toBe('wip-leaf')
  })

  it('in-progress primes a plain to-do within a WP', () => {
    const w = wp('WP1')
    specified(leaf('todo-leaf', w))
    t.setRealization(specified(leaf('wip-leaf', w)), 'in-progress')
    const work = directives().filter((d) => d.mode === 'subagent')
    expect(work[0]!.step.code).toBe('finish-increment')
    expect(work[0]!.target.title).toBe('wip-leaf')
  })
})

// ---- 4. decision-wait ⇒ human-decision with gate.ref = decisionId (delegable, not a bare boolean) ---

describe('directive selector — routing a decision wait (DESIGN §2.A)', () => {
  it('a leaf blocked on a decision ⇒ human-decision directive whose gate.ref IS the decisionId', () => {
    const id = leaf('gated', wp('WP1'), 'feature')
    const decisionId = t.createDecision({
      decisionKind: 'commitment',
      title: 'gate gated',
      workspace: 'ws',
      targets: [id],
      dossier: { context: '', options: [], qa: [] },
    })
    const d = directives().find((x) => x.mode === 'human-decision')!
    expect(d).toBeDefined()
    expect(d.gate?.code).toBe('decision-pending')
    expect(d.gate?.ref).toBe(decisionId) // the actual decisionId, not just "awaited" boolean
    expect(d.target.title).toBe('gated') // the blocked item stays identifiable
    expect(d.commandHint).toBe(`track focus ${decisionId}`)
  })
})

// ---- 5. WSJF absent ⇒ never id-only; all-to-do-no-WSJF ⇒ prioritize-backlog -----------------------

describe('directive selector — priority mix (c) (DESIGN §6)', () => {
  it('with no WSJF anywhere, every directive still carries state facts (never an id alone)', () => {
    const w = wp('WP1')
    t.setRealization(specified(leaf('wip', w)), 'in-progress')
    specified(leaf('todo', w))
    for (const d of directives()) {
      expect(d.facts.bucket).toBeDefined()
      expect(d.facts.realization).toBeDefined()
      expect(d.facts.acceptance).toBeDefined()
      expect(d.facts.wsjf).toBeUndefined() // there is no WSJF, yet the directive is fully qualified
    }
  })

  it('a WP that is all to-do, no WSJF, no discriminant ⇒ a prioritize-backlog directive', () => {
    const w = wp('WP1')
    const a = specified(leaf('a', w))
    const b = specified(leaf('b', w))
    // The representative is the deterministic min-by-id (the §2.B item-8 `target.id` tie-break) — NOT the
    // creation order (ULIDs minted in the same ms are not guaranteed monotonic against creation order).
    const expected = [a, b].sort((x, y) => x.localeCompare(y))[0]
    const ds = directives()
    expect(ds).toHaveLength(1)
    expect(ds[0]!.step.code).toBe('prioritize-backlog')
    expect(ds[0]!.gate?.code).toBe('priority-missing')
    expect(ds[0]!.commandHint).toBe(`track priority assess ${expected}`)
    expect(ds[0]!.affordances).toContain('priority.assess')
  })
})

// ---- 6. NO commandHint ever hints a write/pass (record-only allowlist, DESIGN §5) -----------------

describe('directive selector — record-only commandHint allowlist (DESIGN §5)', () => {
  it('no directive emits a write/pass commandHint across a rich state', () => {
    staleDone(leaf('stale', wp('WP1')))
    failing(leaf('fail', wp('WP2')))
    t.setRealization(specified(leaf('wip', wp('WP3'))), 'in-progress')
    specified(leaf('unprioritized', wp('WP4')))
    const gated = leaf('gated', wp('WP5'), 'feature')
    t.createDecision({ decisionKind: 'commitment', title: 'g', workspace: 'ws', targets: [gated], dossier: { context: '', options: [], qa: [] } })

    const hints = directives().map((d) => d.commandHint).filter((h): h is string => h !== undefined)
    expect(hints.length).toBeGreaterThan(0) // there ARE hints (focus/priority) — proving the negative is meaningful
    for (const h of hints) {
      expect(h).toMatch(/^track (focus|accept run|blocker raise|priority assess|query|report)\b/)
      expect(h).not.toMatch(/\b(realize|done|pass|waived)\b/) // never "realize … done" / "accept … pass|waived"
    }
  })
})

// ---- 7. unknown step code ⇒ inspect-fallback rendering (forward-compat, DESIGN §3/§7) --------------

describe('directive renderer — forward-compat on an unknown step code', () => {
  it('directivePhrase degrades an UNKNOWN step.code to the inspect-fallback phrasing', () => {
    const known = directivePhrase({ mode: 'subagent', step: { code: 'inspect-fallback' }, facts: {} } as unknown as Directive)
    const unknown = directivePhrase({ mode: 'subagent', step: { code: 'some-future-step' }, facts: {} } as unknown as Directive)
    expect(unknown).toBe(known) // an unseen vocabulary entry renders as inspect-fallback, never `undefined`
    expect(unknown).toContain('inspecter')
  })
})

// ---- 8. determinism — two identical runs produce identical output ---------------------------------

describe('directive selector — strict determinism (no flicker, DESIGN §2.B)', () => {
  it('two builds over the same state are byte-identical (directives + dispatchQueue)', () => {
    staleDone(leaf('stale', wp('WP1')))
    failing(leaf('fail', wp('WP2')))
    t.setRealization(specified(leaf('wip', wp('WP3'))), 'in-progress')
    t.assessPriority(specified(leaf('v1', wp('WP4'))), { userBusinessValue: 3, timeCriticality: 1, riskReductionOpportunityEnablement: 1, jobSize: 1 })
    t.assessPriority(specified(leaf('v2', wp('WP5'))), { userBusinessValue: 3, timeCriticality: 1, riskReductionOpportunityEnablement: 1, jobSize: 1 })

    const a = directives()
    const b = directives()
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(dispatchQueueOf(a)).toEqual(dispatchQueueOf(b))
  })
})

// ---- record-only allowlist: the fail-closed REJECT branch (gate nit, DESIGN §5) ------------------
// Both gate reviewers asked for a DIRECT test of the guard's throw — the most sensitive record-only
// invariant. Test #6 only proves generated hints are safe; this proves the rejection branch fail-closes.

describe('assertSafeCommandHint — fail-closed reject of write/outcome verbs', () => {
  it('accepts read / focus / measure hints', () => {
    for (const ok of ['track focus D-1', 'track accept run E-1', 'track blocker raise --target x', 'track priority assess I-1', 'track query', 'track report']) {
      expect(() => assertSafeCommandHint(ok)).not.toThrow()
    }
    expect(() => assertSafeCommandHint(undefined)).not.toThrow()
  })
  it('THROWS on outcome-asserting / write verbs (realize done, accept pass|waive, blocker resolve)', () => {
    for (const bad of ['track item realize I-1 done', 'track accept pass', 'track accept waive C-1', 'track blocker resolve B-1', 'rm -rf /']) {
      expect(() => assertSafeCommandHint(bad)).toThrow(/record-only allowlist/)
    }
  })
})

// ---- acceptance waived / engagement coverage (gate nit) -------------------------------------------
const waivedDone = (id: string): string => {
  t.waive(t.addCriterion(id, 'crit'), 'intentional waiver')
  t.setRealization(id, 'in-progress')
  t.setRealization(id, 'done')
  return id
}

describe('acceptance waived ⇒ no rerun directive (DESIGN §2.B unknown/waived/n-a short-circuit)', () => {
  it('a done+waived leaf is NOT surfaced as a rerun-acceptance debt', () => {
    const p = wp('WP1')
    waivedDone(leaf('waived item', p))
    expect(stepCodes(directives())).not.toContain('rerun-acceptance')
  })
})

describe('routing — an engagement-backed leaf ⇒ h2a-engagement, out of the dispatch queue', () => {
  it('a non-DONE leaf carrying an engagementRef routes to h2a-engagement and is excluded from dispatchQueue', () => {
    const p = wp('WP1')
    t.createItem({ kind: 'feature', title: 'needs remote', workspace: 'ws', parentId: p, engagementRef: 'eng:remote-1' })
    const ds = directives()
    const eng = ds.find((d) => d.mode === 'h2a-engagement')
    expect(eng).toBeDefined()
    expect(eng!.gate?.ref).toBe('eng:remote-1') // delegable: the ref is carried, not just a boolean
    expect(dispatchQueueOf(ds)).not.toContain(eng!.id)
  })
})

// ---- additive view contract: directives + dispatchQueue present; queue is subagent-only ------------

describe('view — additive directives + dispatchQueue (DESIGN §4)', () => {
  it('buildWpConductorView exposes directives[] and a subagent-only dispatchQueue', () => {
    failing(leaf('fail', wp('WP1')))
    const gated = leaf('gated', wp('WP2'), 'feature')
    t.createDecision({ decisionKind: 'commitment', title: 'g', workspace: 'ws', targets: [gated], dossier: { context: '', options: [], qa: [] } })

    const view = buildWpConductorView(computeWpTree(t.state(), cfg))
    expect(view.directives.length).toBeGreaterThanOrEqual(2)
    // The dispatch queue holds exactly the subagent-mode directive ids (no human-decision/h2a entries).
    const subagentIds = view.directives.filter((d) => d.mode === 'subagent').map((d) => d.id)
    expect([...view.dispatchQueue]).toEqual(subagentIds)
    const humanIds = new Set(view.directives.filter((d) => d.mode === 'human-decision').map((d) => d.id))
    for (const qid of view.dispatchQueue) expect(humanIds.has(qid)).toBe(false)
  })
})
