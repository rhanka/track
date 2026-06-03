import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type { State } from '../state/fold.js'

export interface DesyncFinding {
  kind: 'desync'
  itemId: string
  reason: string
}

/**
 * SPEC §4 round-trip / desync rule: when an Item's `body` references a markdown file (a single-line
 * path ending in `.md`), that file MUST exist and its H1 title MUST match the Item title. A missing
 * file or a title mismatch is a desync finding (MVP reports; it never auto-repairs). Inline-prose
 * bodies (the common case, incl. BRANCH-imported items) are not file references and are skipped.
 */
export function desyncFindings(state: State, cwd: string): DesyncFinding[] {
  const findings: DesyncFinding[] = []
  for (const item of state.items.values()) {
    const ref = item.body?.trim()
    if (ref === undefined || !/^[^\n]+\.md$/.test(ref)) continue
    const path = isAbsolute(ref) ? ref : join(cwd, ref)
    if (!existsSync(path)) {
      findings.push({ kind: 'desync', itemId: item.id, reason: `referenced markdown missing: ${ref}` })
      continue
    }
    const h1 = /^#\s+(.+?)\s*$/m.exec(readFileSync(path, 'utf8'))?.[1]
    if (h1 !== undefined && h1 !== item.title) {
      findings.push({
        kind: 'desync',
        itemId: item.id,
        reason: `H1 "${h1}" != item title "${item.title}" (${ref})`,
      })
    }
  }
  return findings
}
