import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { computeDurableWorkspaceId } from '../workspace-id.js'
import { runCli, type CliIO } from './index.js'

// `track workspace-id [--cwd <path>]` prints the durable id (rc=0) or, for a non-git dir, an honest
// stderr line + rc=1. Like `init`/`install-skills`, it touches NO `.track` store — so it must work in a
// repo that was never `track init`-ed.

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim()
}

let repo: string
let out: string[]
let err: string[]
let io: CliIO

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'track-wsid-cli-'))
  out = []
  err = []
  io = { cwd: repo, out: (s) => out.push(s), err: (s) => err.push(s) }
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('track workspace-id', () => {
  it('prints the durable id (rc=0) for a git repo, no .track required', () => {
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'root')

    const code = runCli(['workspace-id'], io)
    expect(code).toBe(0)
    expect(err.join('')).toBe('')
    const printed = out.join('').trim()
    expect(printed).toMatch(/^ws:[0-9a-f]{64}$/)

    const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD')
    expect(printed).toBe(computeDurableWorkspaceId(root, ''))
    // never creates a store
    expect(existsSync(join(repo, '.track'))).toBe(false)
  })

  it('honors --cwd <path> (scopes git I/O to the target repo)', () => {
    const other = mkdtempSync(join(tmpdir(), 'track-wsid-cli-other-'))
    try {
      git(other, 'init', '-q', '-b', 'main')
      git(other, 'commit', '-q', '--allow-empty', '-m', 'root')

      // io.cwd is the (empty) repo dir; --cwd points elsewhere
      const code = runCli(['workspace-id', '--cwd', other], io)
      expect(code).toBe(0)
      const root = git(other, 'rev-list', '--max-parents=0', 'HEAD')
      expect(out.join('').trim()).toBe(computeDurableWorkspaceId(root, ''))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('prints a no-durable-id stderr + rc=1 for a non-git directory', () => {
    const code = runCli(['workspace-id'], io)
    expect(code).toBe(1)
    expect(out.join('')).toBe('')
    expect(err.join('')).toMatch(/not a git repo/i)
  })
})
