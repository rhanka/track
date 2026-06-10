import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCli } from '../cli/index.js'
import { createTrackMcpServer, dispatchReadTool, READ_TOOLS } from '../mcp/server.js'
import { TrackReader } from './contract.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-scopeval-cli-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const cli = (...argv: string[]): { code: number; out: string; err: string } => {
  const out: string[] = []
  const err: string[] = []
  const io = { cwd: dir, out: (s: string) => out.push(s), err: (s: string) => err.push(s) }
  return { code: runCli(argv, io), out: out.join(''), err: err.join('') }
}

describe('scope LOT(b) — CLI `track scope validate`', () => {
  it('rc is ADVISORY: 0 even on a semantic finding (undeclared active WP)', () => {
    cli('init')
    const wp = cli('item', 'new', '--kind', 'chore', '--title', 'WP1', '--workspace', 'ws', '--role', 'workpackage').out.trim()
    cli('item', 'new', '--kind', 'chore', '--title', 'leaf', '--workspace', 'ws', '--parent', wp)
    const r = cli('scope', 'validate', '--workspace', 'ws', '--baseline-commit', 'c1', '--format', 'json')
    expect(r.code).toBe(0) // advisory — NOT a gate
    const parsed = JSON.parse(r.out)
    expect(parsed.status).toBe('fail')
    expect(parsed.findings.map((f: { code: string }) => f.code)).toContain('scope-undeclared')
  })

  it('rc 0 + status pass on a declared coherent WP', () => {
    cli('init')
    const wp = cli('item', 'new', '--kind', 'chore', '--title', 'WP1', '--workspace', 'ws', '--role', 'workpackage').out.trim()
    cli('item', 'new', '--kind', 'chore', '--title', 'leaf', '--workspace', 'ws', '--parent', wp)
    cli('item', 'scope-declare', wp, '--allowed', 'src/**')
    const r = cli('scope', 'validate', '--workspace', 'ws', '--baseline-commit', 'c1', '--format', 'json')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).status).toBe('pass')
  })

  it('text format renders a per-WP summary', () => {
    cli('init')
    const wp = cli('item', 'new', '--kind', 'chore', '--title', 'WP1', '--workspace', 'ws', '--role', 'workpackage').out.trim()
    cli('item', 'new', '--kind', 'chore', '--title', 'leaf', '--workspace', 'ws', '--parent', wp)
    cli('item', 'scope-declare', wp, '--allowed', 'src/**')
    const r = cli('scope', 'validate', '--workspace', 'ws', '--baseline-commit', 'c1')
    expect(r.code).toBe(0)
    expect(r.out).toContain('pass')
  })
})

describe('scope LOT(b) — MCP tool track_scope_validate', () => {
  it('is advertised in READ_TOOLS', () => {
    expect(READ_TOOLS.map((t) => t.name)).toContain('track_scope_validate')
  })

  it('dispatches a read identical to TrackReader.scopeValidate', () => {
    cli('init')
    const wp = cli('item', 'new', '--kind', 'chore', '--title', 'WP1', '--workspace', 'ws', '--role', 'workpackage').out.trim()
    cli('item', 'new', '--kind', 'chore', '--title', 'leaf', '--workspace', 'ws', '--parent', wp)
    const eventsPath = join(dir, '.track', 'events.jsonl')
    const reader = new TrackReader(eventsPath)
    const direct = reader.scopeValidate({ workspace: 'ws', baselineCommit: 'c1' })
    const viaTool = JSON.parse(dispatchReadTool(reader, 'track_scope_validate', { workspace: 'ws', baselineCommit: 'c1' }))
    expect(viaTool).toEqual(direct)
  })

  it('the server builds with the tool registered', () => {
    const server = createTrackMcpServer(join(dir, '.track', 'events.jsonl'))
    expect(server).toBeDefined()
  })
})
