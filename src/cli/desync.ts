import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type { State } from '../state/fold.js'

export interface DesyncFinding {
  kind: 'desync'
  itemId: string
  reason: string
  /** A concrete remediation suggestion (v2.2c). `validate` detects only — it NEVER applies this. */
  hint: string
}

/**
 * SPEC §4 round-trip / desync rule: when an Item's `body` references a markdown file (a single-line
 * path ending in `.md`), that file MUST exist and its H1 title MUST match the Item title. A missing
 * file or a title mismatch is a desync finding (MVP reports; it never auto-repairs). Inline-prose
 * bodies (the common case, incl. BRANCH-imported items) are not file references and are skipped.
 * Each finding carries a `hint` — a suggested fix the human/agent may apply (track never does).
 */
export function desyncFindings(state: State, cwd: string): DesyncFinding[] {
  const findings: DesyncFinding[] = []
  for (const item of state.items.values()) {
    const ref = item.body?.trim()
    if (ref === undefined || !/^[^\n]+\.md$/.test(ref)) continue
    const path = isAbsolute(ref) ? ref : join(cwd, ref)
    if (!existsSync(path)) {
      findings.push({
        kind: 'desync',
        itemId: item.id,
        reason: `referenced markdown missing: ${ref}`,
        hint: `create "${ref}" with an H1 "# ${item.title}", or point the item body elsewhere`,
      })
      continue
    }
    const h1 = /^#\s+(.+?)\s*$/m.exec(readFileSync(path, 'utf8'))?.[1]
    if (h1 === undefined) {
      // SPEC §4 requires the H1 to MATCH the title; a file with no H1 cannot match.
      findings.push({
        kind: 'desync',
        itemId: item.id,
        reason: `referenced markdown has no H1: ${ref}`,
        hint: `add a first-line H1 "# ${item.title}" to "${ref}"`,
      })
    } else if (h1 !== item.title) {
      findings.push({
        kind: 'desync',
        itemId: item.id,
        reason: `H1 "${h1}" != item title "${item.title}" (${ref})`,
        hint: `align them: set the item title to "${h1}", or the H1 in "${ref}" to "# ${item.title}"`,
      })
    }
  }
  return findings
}
