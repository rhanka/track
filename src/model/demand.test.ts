import { describe, expect, it } from 'vitest'

import {
  assertDemandRaised,
  assertDemandTransition,
  assertDispositionOutcome,
  DEMAND_TRANSITIONS,
  isDemandTerminal,
  type DemandStatus,
} from './demand.js'

describe('demand state machine (lifecycle axis)', () => {
  it('allows raised -> qualifying (claim)', () => {
    expect(() => assertDemandTransition('raised', 'qualifying')).not.toThrow()
  })

  it('allows qualifying -> agreed (the pivot)', () => {
    expect(() => assertDemandTransition('qualifying', 'agreed')).not.toThrow()
  })

  it('allows qualifying -> {rejected, duplicate, parked} (off-ramps)', () => {
    expect(() => assertDemandTransition('qualifying', 'rejected')).not.toThrow()
    expect(() => assertDemandTransition('qualifying', 'duplicate')).not.toThrow()
    expect(() => assertDemandTransition('qualifying', 'parked')).not.toThrow()
  })

  it('allows parked -> qualifying (re-entrant)', () => {
    expect(() => assertDemandTransition('parked', 'qualifying')).not.toThrow()
  })

  it('rejects raised -> agreed (must qualify first)', () => {
    expect(() => assertDemandTransition('raised', 'agreed')).toThrow(/illegal demand transition/)
  })

  it('rejects raised -> rejected (every off-ramp is attributable to a qualifier)', () => {
    expect(() => assertDemandTransition('raised', 'rejected')).toThrow(/illegal demand transition/)
  })

  it('rejects any transition out of a terminal status (agreed/rejected/duplicate)', () => {
    for (const terminal of ['agreed', 'rejected', 'duplicate'] as const) {
      expect(() => assertDemandTransition(terminal, 'qualifying')).toThrow(/illegal demand transition/)
    }
  })

  it('marks agreed/rejected/duplicate terminal; raised/qualifying/parked non-terminal', () => {
    expect(isDemandTerminal('agreed')).toBe(true)
    expect(isDemandTerminal('rejected')).toBe(true)
    expect(isDemandTerminal('duplicate')).toBe(true)
    expect(isDemandTerminal('raised')).toBe(false)
    expect(isDemandTerminal('qualifying')).toBe(false)
    expect(isDemandTerminal('parked')).toBe(false)
  })

  it('the transition table is total over DemandStatus (every status has an entry)', () => {
    const statuses: DemandStatus[] = ['raised', 'qualifying', 'agreed', 'rejected', 'duplicate', 'parked']
    for (const s of statuses) expect(DEMAND_TRANSITIONS[s]).toBeDefined()
  })
})

describe('assertDispositionOutcome (the qualifying off-ramp targets)', () => {
  it('accepts rejected|duplicate|parked', () => {
    expect(assertDispositionOutcome('rejected')).toBe('rejected')
    expect(assertDispositionOutcome('duplicate')).toBe('duplicate')
    expect(assertDispositionOutcome('parked')).toBe('parked')
  })

  it('rejects agreed/qualifying/raised (those are not disposition outcomes)', () => {
    for (const bad of ['agreed', 'qualifying', 'raised', 'nope']) {
      expect(() => assertDispositionOutcome(bad)).toThrow()
    }
  })
})

describe('assertDemandRaised (fail-closed payload validation)', () => {
  const ok = {
    type: 'feature' as const,
    raw: { text: 'add dark mode' },
    source: { kind: 'human' as const },
    handler: 'claude:track:abc',
  }

  it('accepts a minimal valid raised payload', () => {
    expect(() => assertDemandRaised(ok)).not.toThrow()
  })

  it('normalizes (drops absent optionals) so the recorded shape is minimal', () => {
    const v = assertDemandRaised(ok)
    expect('sourceKey' in v).toBe(false)
    expect('concerns' in v).toBe(false)
    expect(v).toMatchObject({ type: 'feature', raw: { text: 'add dark mode' }, source: { kind: 'human' }, handler: 'claude:track:abc' })
  })

  it('rejects an unknown type', () => {
    expect(() => assertDemandRaised({ ...ok, type: 'epic' })).toThrow()
  })

  it('rejects a raw without text', () => {
    expect(() => assertDemandRaised({ ...ok, raw: { title: 'no text' } })).toThrow()
  })

  it('rejects an unknown source.kind', () => {
    expect(() => assertDemandRaised({ ...ok, source: { kind: 'robot' } })).toThrow()
  })

  it('rejects a missing handler (who is handling must be logged)', () => {
    const { handler: _drop, ...noHandler } = ok
    expect(() => assertDemandRaised(noHandler)).toThrow(/handler/)
  })

  it('carries type:defect through (a defect is a first-class demand type)', () => {
    const v = assertDemandRaised({ ...ok, type: 'defect', concerns: { kind: 'item', id: 'it-1' } })
    expect(v.type).toBe('defect')
    expect(v.concerns).toEqual({ kind: 'item', id: 'it-1' })
  })
})
