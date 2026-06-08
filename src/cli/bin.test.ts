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
// The repo's LOCAL tsx binary — invoking it directly avoids `npx`'s registry-resolution overhead
// (~25s cold) that made this test exceed its timeout as the import graph grew.
const tsx = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.bin', 'tsx')

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

    // `tsx <symlink> item new`: proves the entry runs runCli even though argv[1] (the symlink) differs
    // from the resolved module path. tsx is a devDependency, so no build step is required.
    const out = execFileSync(
      tsx,
      [link, 'item', 'new', '--kind', 'feature', '--title', 'X', '--workspace', 'ws'],
      { cwd: dir, encoding: 'utf8' },
    )

    expect(out.trim()).not.toBe('') // an id was printed — the command actually executed
    expect(existsSync(join(dir, '.track', 'events.jsonl'))).toBe(true) // and an event was written
  }, 30_000)
})
