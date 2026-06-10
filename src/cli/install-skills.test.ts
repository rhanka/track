import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

// The installer discovers EVERY skill dir under the in-repo `skills/` bundle. These are the two skills
// shipped today; the discovery test below asserts the installer follows the bundle rather than this list.
const SHIPPED_SKILLS = ['present-decision', 'propose-workpackages'] as const

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

describe('track install-skills — discovery (all skills under skills/)', () => {
  it('installs EVERY skill dir in the bundle, not a hardcoded one', () => {
    expect(runCli(['install-skills', '--host', 'claude'], io)).toBe(0)
    // Every shipped skill landed under ~/.claude/skills/<name>/SKILL.md.
    for (const name of SHIPPED_SKILLS) {
      expect(existsSync(join(home, '.claude', 'skills', name, 'SKILL.md'))).toBe(true)
    }
  })

  it('the installed set matches the in-repo skills/ bundle exactly', () => {
    // Anchor on the package root the same way the installer does: this test file lives in src/cli,
    // two dirs below the package root where `skills/` sits.
    const bundleDir = join(__dirname, '..', '..', 'skills')
    const bundled = readdirSync(bundleDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    expect(runCli(['install-skills', '--host', 'claude'], io)).toBe(0)
    const installed = readdirSync(join(home, '.claude', 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    expect(installed).toEqual(bundled)
  })
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

  it('writes the propose-workpackages skill alongside present-decision', () => {
    expect(runCli(['install-skills', '--host', 'claude'], io)).toBe(0)
    const skillMd = join(home, '.claude', 'skills', 'propose-workpackages', 'SKILL.md')
    expect(existsSync(skillMd)).toBe(true)
    expect(readFileSync(skillMd, 'utf8')).toContain('name: propose-workpackages')
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

  it('writes every skill to ~/.codex/skills (propose-workpackages too)', () => {
    expect(runCli(['install-skills', '--host', 'codex'], io)).toBe(0)
    for (const name of SHIPPED_SKILLS) {
      expect(existsSync(join(home, '.codex', 'skills', name, 'SKILL.md'))).toBe(true)
    }
  })

  it('--scope project adds an AGENTS.md pointer for each skill ONLY when AGENTS.md exists', () => {
    const agents = join(repo, 'AGENTS.md')
    writeFileSync(agents, '# Project AGENTS\n\nSome existing content.\n')

    expect(runCli(['install-skills', '--host', 'codex', '--scope', 'project'], io)).toBe(0)
    const text = readFileSync(agents, 'utf8')
    expect(text).toContain('Some existing content.') // existing content preserved
    expect(text).toContain('present-decision') // bounded pointer added
    expect(text).toContain('propose-workpackages') // every skill gets a pointer
  })

  it('--scope project does NOT create AGENTS.md when it is absent (no --force)', () => {
    expect(runCli(['install-skills', '--host', 'codex', '--scope', 'project'], io)).toBe(0)
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(false)
  })

  it('--scope project is idempotent on the AGENTS.md pointer (one Skills section, each pointer once)', () => {
    const agents = join(repo, 'AGENTS.md')
    writeFileSync(agents, '# Project AGENTS\n')
    runCli(['install-skills', '--host', 'codex', '--scope', 'project'], io)
    runCli(['install-skills', '--host', 'codex', '--scope', 'project', '--force'], io)
    const text = readFileSync(agents, 'utf8')
    // Exactly one "## Skills" section header.
    expect(text.split('## Skills').length - 1).toBe(1)
    // Each skill's pointer line is present exactly once (the pointer line begins with `- **<name>**`).
    for (const name of SHIPPED_SKILLS) {
      expect(text.split(`- **${name}**`).length - 1).toBe(1)
    }
  })
})

describe('track install-skills — gemini / agy', () => {
  it('gemini writes a valid command TOML per skill to ~/.gemini/commands', () => {
    expect(runCli(['install-skills', '--host', 'gemini'], io)).toBe(0)
    const toml = join(home, '.gemini', 'commands', 'present-decision.toml')
    expect(existsSync(toml)).toBe(true)
    const text = readFileSync(toml, 'utf8')
    expect(text).toMatch(/^description = "/m)
    expect(text).toContain("prompt = '''")
    expect(text).toContain('Present')
    // every shipped skill gets its own TOML
    expect(existsSync(join(home, '.gemini', 'commands', 'propose-workpackages.toml'))).toBe(true)
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

  it('--host all installs every skill to every host in one run', () => {
    expect(runCli(['install-skills', '--host', 'all'], io)).toBe(0)
    for (const name of SHIPPED_SKILLS) {
      expect(existsSync(join(home, '.claude', 'skills', name, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(home, '.codex', 'skills', name, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(home, '.gemini', 'commands', `${name}.toml`))).toBe(true)
    }
  })
})
