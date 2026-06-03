import { describe, expect, it } from 'vitest'

import { assertRealizationTransition, assertSpecTransition, type ItemState } from './item.js'

function item(over: Partial<ItemState> = {}): ItemState {
  return {
    id: 'i1',
    kind: 'feature',
    title: 't',
    workspace: 'ws',
    specStatus: 'to-specify',
    realization: 'to-do',
    disposition: { orientation: 'required', commitment: 'required' },
    ...over,
  }
}

describe('spec transition guard (SPEC §2.2)', () => {
  it('allows to-specify -> specified', () => {
    expect(() => assertSpecTransition(item(), 'specified')).not.toThrow()
  })

  it('rejects the reverse', () => {
    expect(() => assertSpecTransition(item({ specStatus: 'specified' }), 'to-specify')).toThrow(
      /illegal spec transition/,
    )
  })

  it('rejects any transition on an n/a (decision) axis', () => {
    expect(() =>
      assertSpecTransition(item({ kind: 'decision', specStatus: 'n/a' }), 'specified'),
    ).toThrow(/n\/a/)
  })
})

describe('realization transition guard (SPEC §2.3, §2.6)', () => {
  it('allows to-do -> in-progress', () => {
    expect(() => assertRealizationTransition(item(), 'in-progress', false)).not.toThrow()
  })

  it('rejects skipping to-do -> done', () => {
    expect(() => assertRealizationTransition(item(), 'done', false)).toThrow(
      /illegal realization transition/,
    )
  })

  it('rejects -> rejected without a cause', () => {
    expect(() =>
      assertRealizationTransition(item({ realization: 'in-progress' }), 'rejected', false),
    ).toThrow(/requires a decision cause/)
  })

  it('allows -> rejected from in-progress WITH a cause (the no-go path)', () => {
    expect(() =>
      assertRealizationTransition(item({ realization: 'in-progress' }), 'rejected', true),
    ).not.toThrow()
  })

  it('rejects -> rejected out of a terminal done even with a cause', () => {
    expect(() =>
      assertRealizationTransition(item({ realization: 'done' }), 'rejected', true),
    ).toThrow(/illegal realization transition/)
  })
})
