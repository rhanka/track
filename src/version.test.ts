import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { VERSION } from './version.js'

describe('scaffold', () => {
  it('exposes the package.json version (not a drifting hardcoded constant)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    expect(VERSION).toBe(pkg.version)
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
