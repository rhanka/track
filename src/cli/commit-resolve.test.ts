import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCli, type CliIO } from './index.js'

let dir: string
let out: string[]
let io: CliIO

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initRepo(cwd: string): { head: string } {
  git(['init', '-q'], cwd)
  git(['config', 'user.email', 't@t.t'], cwd)
  git(['config', 'user.name', 'T'], cwd)
  git(['config', 'commit.gpgsign', 'false'], cwd)
  writeFileSync(join(cwd, 'f.txt'), 'one\n')
  git(['add', '.'], cwd)
  git(['commit', '-q', '-m', 'first'], cwd)
  return { head: git(['rev-parse', 'HEAD'], cwd) }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-commit-'))
  out = []
  io = { cwd: dir, out: (s) => out.push(s), err: (s) => out.push(s) }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function last(args: string[]): string {
  out.length = 0
  runCli(args, io)
  return out.join('').trim()
}

/**
 * The graphify footgun: `track report --commit HEAD --require-accepted` must resolve the literal
 * "HEAD" through git to the same SHA the no-flag default resolves — otherwise the run recorded under
 * the resolved SHA never matches the literal string "HEAD", the criterion stays `stale`, and the item
 * never accepts.
 */
describe('CLI --commit normalization through git (cli-boundary)', () => {
  it('report --commit HEAD resolves to the HEAD SHA → item with a pass run at HEAD shows accepted', () => {
    const { head } = initRepo(dir)
    runCli(['init'], io)
    const item = last(['item', 'new', '--kind', 'feature', '--title', 't', '--workspace', 'ws'])
    const crit = last(['accept', 'criterion', item, '--statement', 's'])
    const ev = last(['accept', 'link', crit, '--kind', 'unit', '--locator', 'l'])
    // Record the run at the omitted default (which resolves HEAD == `head`).
    expect(runCli(['accept', 'run', ev, '--result', 'pass'], io)).toBe(0)

    // The exact graphify command: explicit --commit HEAD must match the recorded run.
    out.length = 0
    runCli(['report', '--require-accepted', '--format', 'json', '--commit', 'HEAD'], io)
    const text = out.join('')
    // The acceptance of the item is `pass` at HEAD, NOT `stale`. (Pre-fix: literal 'HEAD' ≠ the
    // recorded SHA `head`, so the criterion is `stale` and the item never accepts.)
    expect(text).toContain('"acceptance": "pass"')
    expect(text).not.toContain('"acceptance": "stale"')
    // The recorded run is under the resolved HEAD SHA.
    expect(head).toMatch(/^[0-9a-f]{40}$/)
  })

  it('record (accept run --commit HEAD) + report (--commit HEAD) agree → accepted', () => {
    initRepo(dir)
    runCli(['init'], io)
    const item = last(['item', 'new', '--kind', 'feature', '--title', 't', '--workspace', 'ws'])
    const crit = last(['accept', 'criterion', item, '--statement', 's'])
    const ev = last(['accept', 'link', crit, '--kind', 'unit', '--locator', 'l'])
    expect(runCli(['accept', 'run', ev, '--result', 'pass', '--commit', 'HEAD'], io)).toBe(0)

    out.length = 0
    runCli(['report', '--require-accepted', '--format', 'json', '--commit', 'HEAD'], io)
    expect(out.join('')).toContain('"acceptance": "pass"')
  })

  it('--commit <full-sha> passes through git rev-parse unchanged', () => {
    const { head } = initRepo(dir)
    runCli(['init'], io)
    const item = last(['item', 'new', '--kind', 'feature', '--title', 't', '--workspace', 'ws'])
    const crit = last(['accept', 'criterion', item, '--statement', 's'])
    const ev = last(['accept', 'link', crit, '--kind', 'unit', '--locator', 'l'])
    expect(runCli(['accept', 'run', ev, '--result', 'pass', '--commit', head], io)).toBe(0)

    out.length = 0
    runCli(['report', '--require-accepted', '--format', 'json', '--commit', head], io)
    const text = out.join('')
    expect(text).toContain('"acceptance": "pass"')
  })

  it('--commit <short-sha> resolves to the full 40-char SHA (record short, report HEAD agree)', () => {
    const { head } = initRepo(dir)
    const short = head.slice(0, 8)
    expect(short).not.toBe(head)
    runCli(['init'], io)
    const item = last(['item', 'new', '--kind', 'feature', '--title', 't', '--workspace', 'ws'])
    const crit = last(['accept', 'criterion', item, '--statement', 's'])
    const ev = last(['accept', 'link', crit, '--kind', 'unit', '--locator', 'l'])
    // Record with a short SHA — must be normalized to the full SHA.
    expect(runCli(['accept', 'run', ev, '--result', 'pass', '--commit', short], io)).toBe(0)

    // Report at HEAD (full SHA) must match the run recorded under the short SHA.
    out.length = 0
    runCli(['report', '--require-accepted', '--format', 'json', '--commit', 'HEAD'], io)
    expect(out.join('')).toContain('"acceptance": "pass"')
  })

  it('non-git dir / bad ref falls back to the literal value without crashing', () => {
    // No git repo here (dir is a fresh tmpdir, never `git init`-ed).
    runCli(['init'], io)
    const item = last(['item', 'new', '--kind', 'feature', '--title', 't', '--workspace', 'ws'])
    const crit = last(['accept', 'criterion', item, '--statement', 's'])
    const ev = last(['accept', 'link', crit, '--kind', 'unit', '--locator', 'l'])
    // A literal commit string survives unchanged (no crash, preserves current behavior).
    expect(runCli(['accept', 'run', ev, '--result', 'pass', '--commit', 'c1'], io)).toBe(0)

    out.length = 0
    runCli(['report', '--require-accepted', '--format', 'json', '--commit', 'c1'], io)
    const text = out.join('')
    expect(text).toContain('"acceptance": "pass"')

    // A bad ref in a real repo also falls back verbatim (no crash). Init a repo and use a junk ref.
    const repo = mkdtempSync(join(tmpdir(), 'track-badref-'))
    try {
      initRepo(repo)
      const io2: CliIO = { cwd: repo, out: (s) => out.push(s), err: (s) => out.push(s) }
      runCli(['init'], io2)
      out.length = 0
      // 'definitely-not-a-ref' fails rev-parse → falls back verbatim, command still succeeds.
      expect(runCli(['validate', '--commit', 'definitely-not-a-ref'], io2)).not.toBe(2)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
