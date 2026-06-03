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
    // relative path is resolved against io.cwd, not process.cwd
    expect(runCli(['branch', 'import', 'BRANCH.md', '--commit', 'c1'], io)).toBe(0)
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

describe('CLI full verb surface (Lot 7) end-to-end', () => {
  function r(args: string[]): { code: number; text: string } {
    out.length = 0
    const code = runCli(args, io)
    return { code, text: out.join('').trim() }
  }

  it('drives item / blocker / accept / priority / decision / query / report / validate', () => {
    expect(r(['init']).code).toBe(0)

    const itemId = r(['item', 'new', '--kind', 'feature', '--title', 'Login', '--workspace', 'ws']).text
    expect(itemId.length).toBeGreaterThan(0)
    expect(r(['item', 'spec', itemId, 'specified']).code).toBe(0)
    expect(r(['item', 'realize', itemId, 'in-progress']).code).toBe(0)

    const refId = r(['item', 'new', '--kind', 'chore', '--title', 'Dep', '--workspace', 'ws']).text
    const blockerId = r([
      'blocker', 'raise', '--target', itemId, '--kind', 'dependency', '--ref', refId, '--rule', 'manual', '--reason', 'x',
    ]).text
    expect(r(['blocker', 'resolve', blockerId]).code).toBe(0)

    const critId = r(['accept', 'criterion', itemId, '--statement', 'user logs in']).text
    const evId = r(['accept', 'link', critId, '--kind', 'e2e', '--locator', 't1']).text
    expect(r(['accept', 'run', evId, '--result', 'pass', '--commit', 'c1']).code).toBe(0)

    expect(r(['priority', 'assess', itemId, '--ubv', '8', '--tc', '2', '--rr', '0', '--js', '2']).text).toContain(
      'wsjf score 5',
    )

    const decId = r(['decision', 'new', '--kind', 'orientation', '--title', 'go?', '--workspace', 'ws', '--targets', refId]).text
    expect(r(['decision', 'outcome', decId, 'go']).code).toBe(0)

    expect(r(['query', '--kind', 'feature', '--format', 'json', '--commit', 'c1']).text).toContain(itemId)
    expect(r(['report', '--decisions', '--commit', 'c1']).code).toBe(0)

    const v = r(['validate', '--commit', 'c1'])
    expect(v.code).toBe(0)
    expect(v.text).toContain('OK')

    expect(r(['item', 'show', itemId]).text).toContain('"specStatus": "specified"')
  })

  it('a domain error returns exit 1 with a message', () => {
    runCli(['init'], io)
    const id = (() => {
      out.length = 0
      runCli(['item', 'new', '--kind', 'feature', '--title', 'X', '--workspace', 'ws'], io)
      return out.join('').trim()
    })()
    out.length = 0
    // to-do -> done is illegal (must pass through in-progress)
    expect(runCli(['item', 'realize', id, 'done'], io)).toBe(1)
    expect(out.join('')).toContain('error: ')
  })

  it('validate flags a desync when an item body references a missing markdown', () => {
    runCli(['init'], io)
    runCli(['item', 'new', '--kind', 'feature', '--title', 'Spec', '--workspace', 'ws', '--body', 'docs/missing.md'], io)
    out.length = 0
    expect(runCli(['validate', '--commit', 'c1'], io)).toBe(1)
    const text = out.join('')
    expect(text).toContain('desync')
    expect(text).toContain('missing')
  })
})
