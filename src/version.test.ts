import { describe, expect, it } from 'vitest'

import { VERSION } from './version.js'

describe('scaffold', () => {
  it('exposes a version', () => {
    expect(VERSION).toBe('0.0.0')
  })
})
