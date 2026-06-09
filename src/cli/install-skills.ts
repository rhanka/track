import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DomainError } from '../model/item.js'
import type { CliIO } from './index.js'

/**
 * `track install-skills` — deploy the in-repo `skills/` bundle onto a host agent's NATIVE skill
 * location, ON DEMAND. The in-repo `skills/` dir is the SINGLE source of truth; the installer
 * copies (claude/codex) or translates (gemini/agy) — it never forks the content.
 *
 * Graceful + idempotent: identical files are left alone (no-op); a DIFFERING existing file is
 * reported and SKIPPED unless `--force` is given; the installer never edits a repo the user did
 * not target (`--scope project` touches the CURRENT repo only), and `--scope user` (default)
 * writes only under the user's `~/.<host>` dirs. HOME is resolved from `$TRACK_INSTALL_HOME` (for
 * tests/injection) then `os.homedir()` — the user's path is NEVER hardcoded.
 */

// `dist/cli/install-skills.js` and `src/cli/install-skills.ts` both sit two dirs below the package
// root, where `skills/` lives (shipped via package.json `files`). Same anchor `version.ts` uses.
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills')

/** The ONE skill this installer deploys; the canonical source is `skills/present-decision/`. */
const SKILL_NAME = 'present-decision'

const HOSTS = ['claude', 'codex', 'gemini', 'agy'] as const
type Host = (typeof HOSTS)[number]
const SCOPES = ['user', 'project'] as const
type Scope = (typeof SCOPES)[number]

/** Resolve the user's HOME — injectable via `$TRACK_INSTALL_HOME` so tests never touch the real `~`. */
function userHome(): string {
  const injected = process.env['TRACK_INSTALL_HOME']
  return injected !== undefined && injected.length > 0 ? injected : homedir()
}

interface SkillFrontmatter {
  readonly name: string
  readonly description: string
  readonly body: string
}

/**
 * Minimal SKILL.md frontmatter parser: the canonical `---\nname: …\ndescription: …\n---\n<body>`
 * shape every shipped skill uses. Multi-line description values fold via indent continuation.
 */
function parseSkill(raw: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m.exec(raw)
  if (match === null) throw new DomainError('SKILL.md missing YAML frontmatter (expected `---` delimiters)')
  const [, fmRaw, body] = match
  const fm: Record<string, string> = {}
  let currentKey: string | undefined
  for (const line of (fmRaw ?? '').split(/\r?\n/)) {
    const kv = /^([a-zA-Z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) {
      currentKey = kv[1]!
      fm[currentKey] = kv[2]!.trim().replace(/^["']|["']$/g, '')
    } else if (currentKey !== undefined && /^\s+/.test(line)) {
      fm[currentKey] = `${fm[currentKey]} ${line.trim()}`
    }
  }
  const name = fm['name']
  const description = fm['description']
  if (name === undefined || description === undefined) {
    throw new DomainError('SKILL.md frontmatter must declare both `name` and `description`')
  }
  return { name, description, body: (body ?? '').trimStart() }
}

/**
 * Render a parsed skill as a Gemini CLI custom-command TOML (`~/.gemini/commands/<name>.toml`):
 * a top-level `description` plus a triple-quoted `prompt` that inlines the procedure. The body is
 * verbatim (TOML literal strings need no escaping); the bundled skill contains no `'''`.
 */
function renderGeminiToml(skill: SkillFrontmatter): string {
  const description = skill.description.replace(/"/g, '\\"')
  const prompt = `You are the ${skill.name} custom command for Gemini CLI.\n\n${skill.body}`
  return [`description = "${description}"`, `prompt = '''`, prompt, `'''`, ''].join('\n')
}

interface InstallResult {
  readonly written: string[]
  readonly skipped: Array<{ path: string; reason: string }>
  readonly unchanged: string[]
}

/** Write `content` to `target`, honoring idempotency + the no-clobber-without-force rule. */
function writeGuarded(target: string, content: string, force: boolean, result: InstallResult): void {
  if (existsSync(target)) {
    const current = readFileSync(target, 'utf8')
    if (current === content) {
      result.unchanged.push(target)
      return
    }
    if (!force) {
      result.skipped.push({ path: target, reason: 'differs (use --force to overwrite)' })
      return
    }
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  result.written.push(target)
}

/**
 * Copy the whole SKILL.md tree (SKILL.md + assets/) into `destDir`, file by file, so the
 * idempotency / no-clobber guard applies per-file. Used for claude + codex (verbatim copy).
 */
function copySkillTree(srcDir: string, destDir: string, force: boolean, result: InstallResult): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    if (entry.isDirectory()) {
      copySkillTree(src, dest, force, result)
    } else if (entry.isFile()) {
      writeGuarded(dest, readFileSync(src, 'utf8'), force, result)
    }
  }
}

const AGENTS_POINTER_HEADER = '## Skills'
const AGENTS_POINTER_LINE =
  `- **present-decision** — present human decisions at the level of the stakes. ` +
  `Entry: \`~/.codex/skills/present-decision/SKILL.md\`.`

/**
 * Add a BOUNDED pointer line to the repo's `AGENTS.md` (the canonical entry) under a "Skills"
 * section — only when AGENTS.md already exists (existing repo methods win; we never create the
 * entrypoint). Idempotent: if the pointer is already present, do nothing.
 */
function addAgentsPointer(repoRoot: string, force: boolean, result: InstallResult): void {
  const agents = join(repoRoot, 'AGENTS.md')
  if (!existsSync(agents)) {
    if (force) {
      // Even with --force we do not fabricate a repo entrypoint the user never had; surface why.
      result.skipped.push({ path: agents, reason: 'AGENTS.md absent — installer never creates a repo entrypoint' })
    } else {
      result.skipped.push({ path: agents, reason: 'AGENTS.md absent (pointer skipped)' })
    }
    return
  }
  const current = readFileSync(agents, 'utf8')
  if (current.includes('present-decision')) {
    result.unchanged.push(agents)
    return
  }
  const sep = current.endsWith('\n') ? '\n' : '\n\n'
  writeFileSync(agents, `${current}${sep}${AGENTS_POINTER_HEADER}\n\n${AGENTS_POINTER_LINE}\n`, 'utf8')
  result.written.push(agents)
}

/**
 * Ensure `GEMINI.md` points BACK to `AGENTS.md` (don't duplicate the body). Only when AGENTS.md
 * exists (the canonical entry to point at). Idempotent.
 */
function ensureGeminiPointer(repoRoot: string, result: InstallResult): void {
  const agents = join(repoRoot, 'AGENTS.md')
  if (!existsSync(agents)) {
    result.skipped.push({ path: join(repoRoot, 'GEMINI.md'), reason: 'AGENTS.md absent (nothing to point at)' })
    return
  }
  const gemini = join(repoRoot, 'GEMINI.md')
  if (existsSync(gemini) && readFileSync(gemini, 'utf8').includes('AGENTS.md')) {
    result.unchanged.push(gemini)
    return
  }
  if (existsSync(gemini)) {
    const current = readFileSync(gemini, 'utf8')
    const sep = current.endsWith('\n') ? '\n' : '\n\n'
    writeFileSync(gemini, `${current}${sep}See \`AGENTS.md\` for the canonical project entrypoint and skills.\n`, 'utf8')
  } else {
    writeFileSync(gemini, `# Gemini\n\nSee \`AGENTS.md\` for the canonical project entrypoint and skills.\n`, 'utf8')
  }
  result.written.push(gemini)
}

/** Install the present-decision skill onto a single host. */
function installOne(host: Host, scope: Scope, force: boolean, repoRoot: string, result: InstallResult): void {
  const srcDir = join(SKILLS_DIR, SKILL_NAME)
  if (!existsSync(srcDir)) {
    throw new DomainError(`skills bundle missing at ${srcDir}`)
  }
  const base = scope === 'user' ? userHome() : repoRoot

  if (host === 'claude' || host === 'codex') {
    const destDir = join(base, `.${host}`, 'skills', SKILL_NAME)
    copySkillTree(srcDir, destDir, force, result)
    if (host === 'codex' && scope === 'project') addAgentsPointer(repoRoot, force, result)
    return
  }

  // gemini + agy share ~/.gemini/commands/<name>.toml (agy imports the gemini command).
  const skill = parseSkill(readFileSync(join(srcDir, 'SKILL.md'), 'utf8'))
  const target = join(base, '.gemini', 'commands', `${SKILL_NAME}.toml`)
  writeGuarded(target, renderGeminiToml(skill), force, result)
  if (scope === 'project') ensureGeminiPointer(repoRoot, result)
}

/**
 * `track install-skills --host <claude|codex|gemini|agy|all> [--scope user|project] [--force]`.
 * `--host` may repeat or be `all` to target several hosts in one run.
 */
export function cmdInstallSkills(args: string[], io: CliIO): number {
  // Hand-parse so `--host` can repeat (the shared parseFlags keeps only the last value).
  const hosts: string[] = []
  let scope: string | undefined
  let force = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--host') {
      const v = args[++i]
      if (v !== undefined) hosts.push(v)
    } else if (a === '--scope') {
      scope = args[++i]
    } else if (a === '--force') {
      force = true
    }
  }

  if (hosts.length === 0) {
    io.err(`track install-skills: --host <${HOSTS.join('|')}|all> is required\n`)
    return 2
  }

  // Expand `all`, de-dup, validate.
  const expanded = hosts.flatMap((h) => (h === 'all' ? [...HOSTS] : [h]))
  const targets: Host[] = []
  for (const h of expanded) {
    if (!(HOSTS as readonly string[]).includes(h)) {
      io.err(`track install-skills: unknown --host "${h}". Supported: ${HOSTS.join(', ')}, all.\n`)
      return 2
    }
    if (!targets.includes(h as Host)) targets.push(h as Host)
  }

  const resolvedScope = (scope ?? 'user') as Scope
  if (!(SCOPES as readonly string[]).includes(resolvedScope)) {
    io.err(`track install-skills: --scope must be one of: ${SCOPES.join('|')}\n`)
    return 2
  }

  const result: InstallResult = { written: [], skipped: [], unchanged: [] }
  try {
    for (const host of targets) {
      installOne(host, resolvedScope, force, io.cwd, result)
    }
  } catch (error) {
    io.err(`track install-skills: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  // Summary of what was written / skipped / left unchanged.
  for (const p of result.written) io.out(`wrote ${p}\n`)
  for (const s of result.skipped) io.out(`skipped ${s.path} (${s.reason})\n`)
  if (result.written.length === 0 && result.skipped.length === 0) {
    io.out(`no-op: ${targets.join(', ')} already up-to-date (${result.unchanged.length} file(s) unchanged)\n`)
  } else {
    io.out(
      `install-skills: ${result.written.length} written, ${result.skipped.length} skipped, ` +
        `${result.unchanged.length} unchanged (host: ${targets.join(', ')}, scope: ${resolvedScope})\n`,
    )
  }
  // A skipped differing file is a graceful, expected outcome (rc=0) — the user is told to pass --force.
  return 0
}
