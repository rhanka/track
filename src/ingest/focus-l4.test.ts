import { describe, expect, it } from 'vitest'

import {
  FOCUS_L4_ACTION_BINDINGS,
  FOCUS_L4_ACTIONS,
  focusL4ActionBinding,
  INGEST_CONTRACT_VERSION,
  type WorkEventKind,
} from './index.js'

describe('Focus L4 action bindings', () => {
  it('maps Focus/Canevas gestures to existing WorkEvent kinds without minting new event types', () => {
    expect(INGEST_CONTRACT_VERSION).toBe('1.3.0')
    expect(FOCUS_L4_ACTIONS).toEqual(['ratifyOutcome', 'amendSpec', 'addDossierArtifact'])

    const kinds: WorkEventKind[] = FOCUS_L4_ACTIONS.map((a) => focusL4ActionBinding(a).workEventKind)
    expect(kinds).toEqual(['decision.outcome', 'item.spec-amend', 'decision.add-artifact'])
  })

  it('marks every L4 action as a binding write requiring authenticated ingest context', () => {
    for (const action of FOCUS_L4_ACTIONS) {
      const binding = FOCUS_L4_ACTION_BINDINGS[action]
      expect(binding.action).toBe(action)
      expect(binding.requiresBindingAuth).toBe(true)
      expect(binding.requiredPayload.length).toBeGreaterThan(0)
      expect(Object.isFrozen(binding)).toBe(true)
    }
    expect(Object.isFrozen(FOCUS_L4_ACTION_BINDINGS)).toBe(true)
  })
})
