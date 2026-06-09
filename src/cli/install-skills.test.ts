import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCli, type CliIO } from './index.js'

// install-skills writes to the host's NATIVE dirs (~/.claude, ~/.codex, ~/.gemini). Tests MUST never
// touch the real user dirs, so every run injects a throwaway HOME via the TRACK_INSTALL_HOME env (the
// installer resolves its `~/.<host>` base from there, falling back to os.homedir() in production).

let home: string
let repo: string
let out: string[]
let err: string[]
let io: CliIO
const SAVED_HOME = process.env['TRACK_INSTALL_HOME']

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'track-skills-home-'))
  repo = mkdtempSync(join(tmpdir(), 'track-skills-repo-'))
  process.env['TRACK_INSTALL_HOME'] = home
  out = []
  err = []
  io = { cwd: repo, out: (s) => out.push(s), err: (s) => err.push(s) }
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
  if (SAVED_HOME === undefined) delete process.env['TRACK_INSTALL_HOME']
  else process.env['TRACK_INSTALL_HOME'] = SAVED_HOME
})

describe('track install-skills — claude', () => {
  it('writes SKILL.md + assets to ~/.claude/skills/present-decision', () => {
    const code = runCli(['install-skills', '--host', 'claude'], io)
    expect(code).toBe(0)

    const skillMd = join(home, '.claude', 'skills', 'present-decision', 'SKILL.md')
    expect(existsSync(skillMd)).toBe(true)
    // copied verbatim — frontmatter intact
    expect(readFileSync(skillMd, 'utf8')).toContain('name: present-decision')
    // assets tree copied too
    for (const asset of ['self-audit.md', 'owner-criteria.template.md', 'dossier-template.md']) {
      expect(existsSync(join(home, '.claude', 'skills', 'present-decision', 'assets', asset))).toBe(true)
    }
  })

  it('is idempotent: a second run is a no-op (no duplicates, no error)', () => {
    expect(runCli(['install-skills', '--host', 'claude'], io)).toBe(0)
    const skillMd = join(home, '.claude', 'skills', 'present-decision', 'SKILL.md')
    const first = readFileSync(skillMd, 'utf8')

    out = []
    expect(runCli(['install-skills', '--host', 'claude'], io)).toBe(0)
    expect(readFileSync(skillMd, 'utf8')).toBe(first)
    expect(out.join('')).toMatch(/up-to-date|unchanged|no-op/i)
  })

  it('skips a DIFFERING existing file without --force, overwrites with --force', () => {
    const skillMd = join(home, '.claude', 'skills', 'present-decision', 'SKILL.md')
    mkdirSync(join(home, '.claude', 'skills', 'present-decision'), { recursive: true })
    writeFileSync(skillMd, 'LOCAL HAND-EDIT — do not clobber\n')

    // without --force: skipped, file preserved, summary says skipped
    out = []
    const skipCode = runCli(['install-skills', '--host', 'claude'], io)
    expect(skipCode).toBe(0)
    expect(readFileSync(skillMd, 'utf8')).toBe('LOCAL HAND-EDIT — do not clobber\n')
    expect(out.join('')).toMatch(/skip/i)

    // with --force: overwritten with canonical content
    out = []
    expect(runCli(['install-skills', '--host', 'claude', '--force'], io)).toBe(0)
    expect(readFileSync(skillMd, 'utf8')).toContain('name: present-decision')
  })
})

describe('track install-skills — codex', () => {
  it('writes SKILL.md + assets to ~/.codex/skills/present-decision', () => {
    expect(runCli(['install-skills', '--host', 'codex'], io)).toBe(0)
    const skillMd = join(home, '.codex', 'skills', 'present-decision', 'SKILL.md')
    expect(existsSync(skillMd)).toBe(true)
    expect(existsSync(join(home, '.codex', 'skills', 'present-decision', 'assets', 'self-audit.md'))).toBe(true)
  })

  it('--scope project adds an AGENTS.md pointer ONLY when AGENTS.md exists', () => {
    const agents = join(repo, 'AGENTS.md')
    writeFileSync(agents, '# Project AGENTS\n\nSome existing content.\n')

    expect(runCli(['install-skills', '--host', 'codex', '--scope', 'project'], io)).toBe(0)
    const text = readFileSync(agents, 'utf8')
    expect(text).toContain('Some existing content.') // existing content preserved
    expect(text).toContain('present-decision') // bounded pointer added
  })

  it('--scope project does NOT create AGENTS.md when it is absent (no --force)', () => {
    expect(runCli(['install-skills', '--host', 'codex', '--scope', 'project'], io)).toBe(0)
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(false)
  })

  it('--scope project is idempotent on the AGENTS.md pointer (no duplicate lines)', () => {
    const agents = join(repo, 'AGENTS.md')
    writeFileSync(agents, '# Project AGENTS\n')
    runCli(['install-skills', '--host', 'codex', '--scope', 'project'], io)
    runCli(['install-skills', '--host', 'codex', '--scope', 'project', '--force'], io)
    // The bounded pointer is inserted exactly once — count the "## Skills" section header, not the
    // word "present-decision" (which appears twice within the single pointer line itself).
    const sections = readFileSync(agents, 'utf8').split('## Skills').length - 1
    expect(sections).toBe(1)
  })
})

describe('track install-skills — gemini / agy', () => {
  it('gemini writes a valid command TOML to ~/.gemini/commands/present-decision.toml', () => {
    expect(runCli(['install-skills', '--host', 'gemini'], io)).toBe(0)
    const toml = join(home, '.gemini', 'commands', 'present-decision.toml')
    expect(existsSync(toml)).toBe(true)
    const text = readFileSync(toml, 'utf8')
    expect(text).toMatch(/^description = "/m)
    expect(text).toContain("prompt = '''")
    expect(text).toContain('Present')
  })

  it('agy is an alias for the same gemini TOML target', () => {
    expect(runCli(['install-skills', '--host', 'agy'], io)).toBe(0)
    expect(existsSync(join(home, '.gemini', 'commands', 'present-decision.toml'))).toBe(true)
  })

  it('--scope project points GEMINI.md back to AGENTS.md (when AGENTS.md exists)', () => {
    writeFileSync(join(repo, 'AGENTS.md'), '# Project AGENTS\n')
    expect(runCli(['install-skills', '--host', 'gemini', '--scope', 'project'], io)).toBe(0)
    const gemini = join(repo, 'GEMINI.md')
    expect(existsSync(gemini)).toBe(true)
    expect(readFileSync(gemini, 'utf8')).toContain('AGENTS.md')
  })
})

describe('track install-skills — errors & multi-host', () => {
  it('unknown --host is a usage error (rc=2)', () => {
    expect(runCli(['install-skills', '--host', 'emacs'], io)).toBe(2)
    expect(err.join('')).toMatch(/host/i)
  })

  it('missing --host is a usage error (rc=2)', () => {
    expect(runCli(['install-skills'], io)).toBe(2)
  })

  it('--host all installs to every host in one run', () => {
    expect(runCli(['install-skills', '--host', 'all'], io)).toBe(0)
    expect(existsSync(join(home, '.claude', 'skills', 'present-decision', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.codex', 'skills', 'present-decision', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.gemini', 'commands', 'present-decision.toml'))).toBe(true)
  })
})
