import { describe, expect, it } from 'vitest'

import { assertManualResolve, type BlockerState } from './blocker.js'

function blocker(over: Partial<BlockerState> = {}): BlockerState {
  return {
    id: 'b1',
    targetId: 't',
    kind: 'dependency',
    ref: 'r',
    reason: 'x',
    openedAt: '2026-06-03T10:00:00.000Z',
    resolvedByEvent: false,
    open: true,
    ...over,
  }
}

describe('manual resolve guard (SPEC §2.9)', () => {
  it('allows a manual dependency blocker', () => {
    expect(() =>
      assertManualResolve(blocker({ kind: 'dependency', resolutionRule: 'manual' })),
    ).not.toThrow()
  })

  it('rejects a linked-done dependency blocker', () => {
    expect(() =>
      assertManualResolve(blocker({ kind: 'dependency', resolutionRule: 'linked-done' })),
    ).toThrow(/cannot manually resolve a 'linked-done'/)
  })

  it('rejects a decision blocker', () => {
    expect(() => assertManualResolve(blocker({ kind: 'decision' }))).toThrow(
      /cannot manually resolve a decision blocker/,
    )
  })
})
