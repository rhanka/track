import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { computeDurableWorkspaceId, durableWorkspaceId } from './workspace-id.js'

// WP4 multi-worktree stable-id. The pure core is shipped BYTE-FOR-BYTE with a2a-cli (h2a 0.63.0):
//   computeDurableWorkspaceId(root, rel) = 'ws:' + sha256hex(root + '\n' + rel)  (UTF-8)
// PATH-independent (same repo from any subdir/clone) + MACHINE-independent (no host/path salt).

describe('computeDurableWorkspaceId — conformance gate (h2a published vectors)', () => {
  // These two MUST stay green or track may NOT ship: they are h2a's byte-for-byte vectors.
  it("('abc','') matches the main-worktree vector", () => {
    expect(computeDurableWorkspaceId('abc', '')).toBe(
      'ws:edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb',
    )
  })
  it("('abc','my-feature') matches the linked-worktree vector", () => {
    expect(computeDurableWorkspaceId('abc', 'my-feature')).toBe(
      'ws:81a25e53c1b1c56cc708a5fed4958388aeaef6c611b18e01d61c4a21a5e61820',
    )
  })
})

describe('computeDurableWorkspaceId — framing', () => {
  it("prefixes 'ws:' then 64 lowercase hex chars", () => {
    expect(computeDurableWorkspaceId('abc', '')).toMatch(/^ws:[0-9a-f]{64}$/)
  })

  it("hashes exactly root + a SINGLE '\\n' + rel (no extra delimiter)", () => {
    // Independent recomputation of the framing, so a drift in the join (e.g. '\n\n', '/', or rel-first)
    // is caught here rather than only via the opaque vectors.
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    const expected = 'ws:' + createHash('sha256').update('root-sha' + '\n' + 'feat', 'utf8').digest('hex')
    expect(computeDurableWorkspaceId('root-sha', 'feat')).toBe(expected)
  })

  it("the empty-rel payload ends with '\\n' (main worktree), distinct from a non-empty rel", () => {
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    const main = 'ws:' + createHash('sha256').update('R\n', 'utf8').digest('hex')
    expect(computeDurableWorkspaceId('R', '')).toBe(main)
    expect(computeDurableWorkspaceId('R', '')).not.toBe(computeDurableWorkspaceId('R', 'x'))
  })

  it('is UTF-8 framed (multibyte rel hashes its bytes, not code units)', () => {
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    const expected = 'ws:' + createHash('sha256').update(Buffer.from('R\ncafé-é', 'utf8')).digest('hex')
    expect(computeDurableWorkspaceId('R', 'café-é')).toBe(expected)
  })
})

// ---- I/O layer: real git repos in TEMP dirs (no network, no real user dirs) ----

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim()
}

describe('durableWorkspaceId — git I/O', () => {
  let repo: string
  let tmps: string[]

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'track-wsid-'))
    tmps = [repo]
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'root')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'second')
  })

  afterEach(() => {
    for (const d of tmps) rmSync(d, { recursive: true, force: true })
  })

  it('returns a ws: id derived from the ROOT commit (not HEAD)', () => {
    const id = durableWorkspaceId(repo)
    expect(id).toMatch(/^ws:[0-9a-f]{64}$/)
    const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD')
    // main worktree ⇒ rel '' ; derived from root, so it equals the pure compute of (root, '')
    expect(id).toBe(computeDurableWorkspaceId(root, ''))
  })

  it('is PATH-independent: same id from a subdirectory of the repo', () => {
    const sub = join(repo, 'a', 'b', 'c')
    execFileSync('mkdir', ['-p', sub])
    expect(durableWorkspaceId(sub)).toBe(durableWorkspaceId(repo))
  })

  it('a linked worktree yields a DIFFERENT id (basename of --git-dir as rel)', () => {
    const wt = mkdtempSync(join(tmpdir(), 'track-wsid-wt-'))
    rmSync(wt, { recursive: true, force: true }) // git worktree add wants a non-existent path
    git(repo, 'worktree', 'add', '-q', '-b', 'feat', wt)
    tmps.push(wt)

    const mainId = durableWorkspaceId(repo)
    const wtId = durableWorkspaceId(wt)
    expect(wtId).toMatch(/^ws:[0-9a-f]{64}$/)
    expect(wtId).not.toBe(mainId)

    // rel is the basename of the linked worktree's --git-dir (.git/worktrees/<name>)
    const linkedGitDir = git(wt, 'rev-parse', '--git-dir')
    const name = linkedGitDir.replace(/\/+$/, '').split('/').pop()!
    const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD')
    expect(wtId).toBe(computeDurableWorkspaceId(root, name))
  })

  it('returns undefined for a non-git directory (no machine+path fallback)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'track-wsid-nogit-'))
    tmps.push(plain)
    expect(durableWorkspaceId(plain)).toBeUndefined()
  })

  it('joins MULTIPLE root commits sorted ASCENDING with commas', () => {
    // A second history with its own root, grafted in via `git replace --graft`-free path: merge two
    // orphan branches so HEAD reaches two root commits, then assert the sort+join order.
    git(repo, 'checkout', '-q', '--orphan', 'second-root')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'other-root')
    git(repo, 'checkout', '-q', 'main')
    git(repo, 'merge', '-q', '--allow-unrelated-histories', '--no-edit', 'second-root')

    const roots = git(repo, 'rev-list', '--max-parents=0', 'HEAD').split('\n').filter(Boolean)
    expect(roots.length).toBeGreaterThanOrEqual(2)
    const joined = [...roots].sort().join(',')
    expect(durableWorkspaceId(repo)).toBe(computeDurableWorkspaceId(joined, ''))
  })
})
