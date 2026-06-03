import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { canonicalize } from './canonical.js'
import type { Sha256 } from './types.js'

/**
 * Non-authoritative anchor that lets `validate` detect suffix **truncation** of the
 * append-only log (SPEC §3 threat model). The log stays the source of truth; the head is a
 * convenience pointer (like snapshots), rebuildable from the log, and additionally durable via
 * the docs-git backend.
 */
export interface Head {
  streamLength: number
  lastContentHash: Sha256 | null
}

export function headPath(eventsPath: string): string {
  return join(dirname(eventsPath), 'head.json')
}

/**
 * Read the head, or `null` if it is missing, unparseable, OR malformed in shape. The head is
 * rebuildable, so any problem must degrade to "no head" (never throw, never a bogus anchor that
 * would silently disable detection or raise a false truncation/head-mismatch).
 */
export function readHead(eventsPath: string): Head | null {
  const p = headPath(eventsPath)
  if (!existsSync(p)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const len = record['streamLength']
  const last = record['lastContentHash']
  if (typeof len !== 'number' || !Number.isInteger(len) || len < 0) return null
  if (len === 0) {
    if (last !== null) return null
    return { streamLength: 0, lastContentHash: null }
  }
  if (typeof last !== 'string' || !last.startsWith('sha256:')) return null
  return { streamLength: len, lastContentHash: last as Sha256 }
}

/** Write the head atomically (temp file + fsync + rename) so a crash never leaves a torn head. */
export function writeHead(eventsPath: string, head: Head): void {
  const p = headPath(eventsPath)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, canonicalize(head) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, p)
}
