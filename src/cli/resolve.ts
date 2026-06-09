import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * P0 — Shared store resolver (CLI + track-mcp). The single rule for WHERE a command's `.track` lives,
 * so the CLI and the MCP server can never disagree and a write can never land in a stray, auto-created
 * sidecar (root cause (b): a subdir/worktree write to `join(cwd,'.track')` while the watched root log is
 * untouched). Resolution order:
 *   1. an explicit `--track-dir <path>` flag, else `TRACK_DIR` env — used VERBATIM (must already exist);
 *   2. otherwise walk UPWARD from `cwd` to the nearest existing ancestor `.track` directory.
 * No creation, ever: `track init` is the ONLY command that creates a new `.track`. Every other command
 * fails loud (this throws ⇒ rc=1 + stderr) when none is found, rather than silently materializing one.
 */
export class TrackDirNotFoundError extends Error {
  constructor(cwd: string, hadOverride: boolean) {
    super(
      hadOverride
        ? `track: the requested --track-dir / TRACK_DIR does not exist. ` +
            `track never creates a store implicitly — run \`track init\` there first.`
        : `track: no .track directory found in ${cwd} or any parent. ` +
            `Run \`track init\` to create one (this is the ONLY command that does), or pass --track-dir / TRACK_DIR.`,
    )
    this.name = 'TrackDirNotFoundError'
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export interface ResolveOptions {
  cwd: string
  /** `--track-dir <path>` (highest precedence). */
  flag?: string | undefined
  /** `TRACK_DIR` env (used only if `flag` is absent). */
  env?: string | undefined
}

/**
 * Resolve the `.track` directory for a NON-init command. Throws `TrackDirNotFoundError` if none is
 * found (or an explicit override does not exist). NEVER creates a directory.
 */
export function resolveTrackDir(opts: ResolveOptions): string {
  const override = opts.flag ?? opts.env
  if (override !== undefined && override.length > 0) {
    const abs = isAbsolute(override) ? override : resolve(opts.cwd, override)
    if (!isDir(abs)) throw new TrackDirNotFoundError(opts.cwd, true)
    return abs
  }

  let cur = resolve(opts.cwd)
  for (;;) {
    const candidate = join(cur, '.track')
    if (existsSync(candidate) && isDir(candidate)) return candidate
    const parent = dirname(cur)
    if (parent === cur) break // reached the filesystem root
    cur = parent
  }
  throw new TrackDirNotFoundError(opts.cwd, false)
}

/** The `.track` directory `track init` should CREATE for `cwd` (always `cwd/.track`, or an explicit override). */
export function initTrackDir(opts: ResolveOptions): string {
  const override = opts.flag ?? opts.env
  if (override !== undefined && override.length > 0) {
    return isAbsolute(override) ? override : resolve(opts.cwd, override)
  }
  return join(resolve(opts.cwd), '.track')
}
