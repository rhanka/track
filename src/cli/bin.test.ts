import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Regression guard for the installed-bin bug: a global/npx install exposes `track` as a SYMLINK
// in bin/ pointing at the entry module. The old main-module guard compared argv[1] (the symlink)
// against the resolved module path and never matched, so the installed CLI ran nothing. Here we
// reproduce that exact shape — invoke the bin THROUGH a symlink — and assert it actually writes.
const binSrc = join(dirname(fileURLToPath(import.meta.url)), 'bin.ts')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-bin-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('cli bin entry — installed-bin (symlink) regression', () => {
  it('runs runCli when invoked via a symlinked path', () => {
    const link = join(dir, 'track-link.ts')
    symlinkSync(binSrc, link)
    expect(readlinkSync(link)).toBe(binSrc) // sanity: argv[1] will be the symlink, not the module

    // `npx tsx <symlink> init` then `item new`: proves the entry runs even though argv[1] differs
    // from the resolved module path. Uses tsx (a devDependency) so no build step is required.
    execFileSync('npx', ['tsx', link, 'init'], { cwd: dir, stdio: 'pipe' })
    const out = execFileSync(
      'npx',
      ['tsx', link, 'item', 'new', '--kind', 'feature', '--title', 'X', '--workspace', 'ws'],
      { cwd: dir, encoding: 'utf8' },
    )

    expect(out.trim()).not.toBe('') // an id was printed — the command actually executed
    expect(existsSync(join(dir, '.track', 'events.jsonl'))).toBe(true) // and an event was written
  }, 30_000)
})
