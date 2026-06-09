import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'

/**
 * WP4 — the durable, multi-worktree workspace id. Shipped BYTE-FOR-BYTE with a2a-cli (h2a 0.63.0):
 * track aligned on the SAME pure function so an id minted on either side is interchangeable.
 *
 * The id is PATH-independent (same value from any clone path or subdirectory) and MACHINE-independent
 * (no host name / absolute path is hashed in) — it is salted ONLY by the repo's root-commit SHA(s) and
 * the linked-worktree name, both of which travel with the repository.
 */

/**
 * The canonical pure core — MUST match h2a exactly:
 *   computeDurableWorkspaceId(root, rel) = 'ws:' + sha256hex( root + '\n' + rel )
 *
 * UTF-8; a SINGLE '\n' separates the two fields; `worktreeRelPath` is '' for the main worktree (so the
 * hashed payload then ends with '\n'). Do NOT reframe (no second delimiter, no rel-first ordering) — the
 * published conformance vectors pin this byte layout and the test gate asserts them.
 */
export function computeDurableWorkspaceId(rootCommitSHA: string, worktreeRelPath: string): string {
  const digest = createHash('sha256').update(`${rootCommitSHA}\n${worktreeRelPath}`, 'utf8').digest('hex')
  return `ws:${digest}`
}

/**
 * Canonicalize a git-reported dir (relative-to-`cwd` or absolute) to a comparable absolute path. Falls
 * back to the lexically-resolved path when the dir cannot be realpath'd (it always exists for a live
 * repo, but staying total keeps the equality check from throwing on an exotic layout).
 */
function canonical(cwd: string, dir: string): string {
  const abs = resolve(cwd, dir)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** Run git inside `cwd`, capture stdout, silence git's own stderr; throws on a non-zero exit. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/**
 * Resolve the durable workspace id for the repo containing `cwd`, doing the git I/O via execFileSync.
 *
 * rootCommitSHA = `git rev-list --max-parents=0 HEAD`; if a repo has MULTIPLE root commits (merged
 * unrelated histories / grafts) ALL of them are taken, sorted ASCENDING, and joined with ','.
 *
 * worktreeRelPath = '' for the MAIN worktree (detected when `--git-dir` equals `--git-common-dir`),
 * otherwise the basename of `--git-dir` — i.e. the linked-worktree's name under `.git/worktrees/`.
 *
 * Returns `undefined` when `cwd` is not inside a git repo or any git invocation errors. A non-git
 * directory is OUT OF SCOPE — we deliberately do NOT synthesize a machine+path fallback (that would
 * be neither path- nor machine-independent, and would diverge from h2a).
 */
export function durableWorkspaceId(cwd: string): string | undefined {
  try {
    const roots = git(cwd, ['rev-list', '--max-parents=0', 'HEAD'])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (roots.length === 0) return undefined
    const rootCommitSHA = [...roots].sort().join(',')

    const gitDir = git(cwd, ['rev-parse', '--git-dir'])
    const commonDir = git(cwd, ['rev-parse', '--git-common-dir'])
    // Main worktree ⇒ the two point at the SAME dir ⇒ rel ''. A linked worktree has its own
    // `--git-dir` of `…/.git/worktrees/<name>`; its basename is the stable, path-free worktree name.
    // git reports these RELATIVE to cwd OR absolute, inconsistently (e.g. from a subdir `--git-dir` is
    // absolute while `--git-common-dir` stays relative), so a raw string compare misfires — resolve
    // both to canonical absolute paths against `cwd` before comparing. Compare on the RESOLVED path,
    // but derive the worktree name from the RAW `--git-dir` (canonicalizing could rewrite the name).
    const worktreeRelPath = canonical(cwd, gitDir) === canonical(cwd, commonDir) ? '' : basename(gitDir.replace(/\/+$/, ''))

    return computeDurableWorkspaceId(rootCommitSHA, worktreeRelPath)
  } catch {
    // Not a git repo, or git absent/errored — out of scope, no fallback.
    return undefined
  }
}
