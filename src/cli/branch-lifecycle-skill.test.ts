import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCli, type CliIO } from './index.js'

// B1 — the `branch-lifecycle` skill ships in the in-repo `skills/` bundle (SKILL.md + an executable
// `assets/check.sh` wrapper) and is discovered/packaged by `install-skills` exactly like every other
// skill (the installer follows the bundle, never a hardcoded list). These tests pin that it is present
// in the bundle AND lands verbatim — SKILL.md and its asset — on a host install.

const BUNDLE = join(__dirname, '..', '..', 'skills', 'branch-lifecycle')

let home: string
let repo: string
let io: CliIO
const SAVED_HOME = process.env['TRACK_INSTALL_HOME']

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'track-bl-home-'))
  repo = mkdtempSync(join(tmpdir(), 'track-bl-repo-'))
  process.env['TRACK_INSTALL_HOME'] = home
  io = { cwd: repo, out: () => {}, err: () => {} }
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
  if (SAVED_HOME === undefined) delete process.env['TRACK_INSTALL_HOME']
  else process.env['TRACK_INSTALL_HOME'] = SAVED_HOME
})

describe('B1 — branch-lifecycle skill packaging', () => {
  it('the bundle carries SKILL.md (frontmatter name) + assets/check.sh', () => {
    const skillMd = readFileSync(join(BUNDLE, 'SKILL.md'), 'utf8')
    expect(skillMd).toMatch(/^---/)
    expect(skillMd).toMatch(/\bname:\s*branch-lifecycle\b/)
    // The skill detects loss via the B0b verb, not via audit.orphan.
    expect(skillMd).toContain('events-contains')
    expect(existsSync(join(BUNDLE, 'assets', 'check.sh'))).toBe(true)
    expect(readFileSync(join(BUNDLE, 'assets', 'check.sh'), 'utf8')).toContain('events-contains')
  })

  it('install-skills discovers and copies the skill tree onto the host verbatim', () => {
    expect(runCli(['install-skills', '--host', 'claude'], io)).toBe(0)
    const dest = join(home, '.claude', 'skills', 'branch-lifecycle')
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dest, 'assets', 'check.sh'))).toBe(true)
    // Verbatim copy: installed bytes equal the bundle's.
    expect(readFileSync(join(dest, 'assets', 'check.sh'), 'utf8')).toBe(
      readFileSync(join(BUNDLE, 'assets', 'check.sh'), 'utf8'),
    )
  })
})
