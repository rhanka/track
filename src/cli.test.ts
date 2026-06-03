import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCli, type CliIO } from './cli/index.js'

const FIXTURE = `# Feature: BR-99 — Demo Feature

## Objective
Demonstrate the CLI.

## Plan / Todo (lot-based)
- [x] **Lot 0 — Scaffold the thing**
- [ ] **Lot 1 — Core logic**
  - [x] UAT: web app loads
`

let dir: string
let out: string[]
let io: CliIO

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-cli-'))
  out = []
  io = { cwd: dir, out: (s) => out.push(s), err: (s) => out.push(s) }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('CLI smoke (Milestone 1): init -> branch import -> report', () => {
  it('imports a BRANCH.md and reports, leaving the file byte-identical (read-only)', () => {
    const branchFile = join(dir, 'BRANCH.md')
    writeFileSync(branchFile, FIXTURE)
    const hashBefore = sha256File(branchFile)

    expect(runCli(['init'], io)).toBe(0)
    expect(runCli(['branch', 'import', branchFile, '--commit', 'c1'], io)).toBe(0)
    expect(runCli(['report', '--format', 'text', '--commit', 'c1'], io)).toBe(0)

    const text = out.join('')
    expect(text).toContain('Initialized .track/')
    expect(text).toContain('Imported br-99: 4 created') // feature + 2 lots + 1 UAT criterion
    expect(text).toContain('DONE (1)') // Lot 0 done
    expect(text).toContain('Scaffold the thing')

    // BRANCH.md is the source of truth — the importer must never write it.
    expect(sha256File(branchFile)).toBe(hashBefore)
  })

  it('report --format md renders markdown headings', () => {
    const branchFile = join(dir, 'BRANCH.md')
    writeFileSync(branchFile, FIXTURE)
    runCli(['init'], io)
    runCli(['branch', 'import', branchFile, '--commit', 'c1'], io)
    out = []
    runCli(['report', '--format', 'md', '--commit', 'c1'], io)
    expect(out.join('')).toContain('## DONE')
  })

  it('prints usage and returns non-zero on an unknown command', () => {
    expect(runCli(['frobnicate'], io)).toBe(2)
    expect(out.join('')).toContain('usage: track')
  })
})
