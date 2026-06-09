// Launch/serve alignment (fix): the CLI READ commands (report/query/validate) must serve-empty when no
// `.track` resolves — rc=0, empty output, a stderr `track init` hint, and NEVER a create. WRITES keep
// failing loud (covered by p0-write-loss.test.ts). A malformed EXISTING log still validates as INVALID.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCli, type CliIO } from './index.js'

let root: string
let out: string[]
let err: string[]

function io(cwd: string): CliIO {
  return { cwd, out: (s) => out.push(s), err: (s) => err.push(s) }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'track-read-empty-'))
  out = []
  err = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('CLI reads — serve-empty when no .track resolves (rc=0, hint, no create)', () => {
  it('report with no .track: rc=0, empty buckets, stderr `track init` hint, no create', () => {
    const sub = join(root, 'unadopted')
    mkdirSync(sub, { recursive: true })
    const code = runCli(['report', '--format', 'json'], io(sub))
    expect(code).toBe(0)
    expect(JSON.parse(out.join('')).buckets.AWAITED).toEqual([])
    expect(err.join('')).toMatch(/track init/)
    expect(existsSync(join(sub, '.track'))).toBe(false)
    expect(existsSync(join(root, '.track'))).toBe(false)
  })

  it('query with no .track: rc=0, empty [], stderr hint, no create', () => {
    const sub = join(root, 'unadopted-q')
    mkdirSync(sub, { recursive: true })
    const code = runCli(['query', '--format', 'json'], io(sub))
    expect(code).toBe(0)
    expect(JSON.parse(out.join(''))).toEqual([])
    expect(err.join('')).toMatch(/track init/)
    expect(existsSync(join(sub, '.track'))).toBe(false)
  })

  it('validate with no .track: rc=0, integral empty stream (OK) + a no-store warning, no create', () => {
    const sub = join(root, 'unadopted-v')
    mkdirSync(sub, { recursive: true })
    const code = runCli(['validate'], io(sub))
    expect(code).toBe(0)
    expect(out.join('')).toMatch(/OK/)
    expect(err.join('')).toMatch(/track init/)
    expect(existsSync(join(sub, '.track'))).toBe(false)
  })

  it('validate on a MALFORMED existing log stays INVALID / rc=1 (not masked by serve-empty)', () => {
    expect(runCli(['init'], io(root))).toBe(0)
    out = []
    err = []
    // Corrupt the existing log with a torn line — an EXISTING store must fail-closed, not serve-empty.
    writeFileSync(join(root, '.track', 'events.jsonl'), '{not json\n')
    const code = runCli(['validate'], io(root))
    expect(code).toBe(1)
    expect(out.join('')).toMatch(/INVALID/)
  })

  it('a bad explicit --track-dir still fails loud on a READ (rc=1, not serve-empty)', () => {
    const code = runCli(['report', '--track-dir', join(root, 'nope')], io(root))
    expect(code).toBe(1)
    expect(err.join('')).toMatch(/error/)
  })
})
