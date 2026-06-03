export interface ParsedUat {
  uatSlug: string
  statement: string
  passed: boolean
}

export interface ParsedLot {
  lotSlug: string
  title: string
  done: boolean
  uat: ParsedUat[]
}

export interface ParsedBranch {
  branchSlug: string
  feature: { title: string; body: string }
  lots: ParsedLot[]
}

/** Stable kebab slug from a title fragment (NFKD-folded, non-alphanumerics → `-`). */
export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const FEATURE = /^#\s*Feature:\s*(.+?)\s*$/
const HEADING = /^##\s+(.+?)\s*$/
// A top-level lot: `- [x] **Lot 0 — Restart from zero**` (em/en dash or hyphen separator).
const LOT = /^-\s*\[([ xX])\]\s*\*\*Lot\s+\S+\s*[—–-]\s*(.+?)\s*\*\*/
// A nested checkbox (gate or UAT): leading indentation required.
const NESTED = /^\s+-\s*\[([ xX])\]\s*(.+?)\s*$/

function brSlug(title: string, fileSlug: string | undefined): string {
  const brId = /\bBR-?[A-Za-z0-9]+/.exec(title)?.[0]
  if (brId) return slugify(brId)
  if (fileSlug) return slugify(fileSlug)
  return slugify(title)
}

/**
 * Parse the stable `BRANCH_TEMPLATE` sections (SPEC §5): `# Feature:` → title; `## Objective` +
 * `## Scope` → body; `## Plan / Todo (lot-based)` → lots (`- [x] **Lot N — slug**`); UAT
 * checkboxes nested under a lot (text contains "UAT") → criteria. Gate sub-checkboxes are ignored.
 * Tolerant: unknown sections are skipped; never throws on extra prose.
 */
export function parseBranch(content: string, opts: { fileSlug?: string } = {}): ParsedBranch {
  const lines = content.split('\n')

  let title = ''
  const objective: string[] = []
  const scope: string[] = []
  const lots: ParsedLot[] = []

  let section: 'none' | 'objective' | 'scope' | 'plan' | 'other' = 'none'
  let currentLot: ParsedLot | undefined

  for (const line of lines) {
    const feature = FEATURE.exec(line)
    if (feature) {
      title = feature[1]!
      section = 'none'
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const name = heading[1]!.toLowerCase()
      section = name.startsWith('objective')
        ? 'objective'
        : name.startsWith('scope')
          ? 'scope'
          : name.startsWith('plan')
            ? 'plan'
            : 'other'
      currentLot = undefined
      continue
    }

    if (section === 'objective') {
      if (line.trim()) objective.push(line.trim())
      continue
    }
    if (section === 'scope') {
      if (line.trim()) scope.push(line.trim())
      continue
    }
    if (section === 'plan') {
      const lot = LOT.exec(line)
      if (lot) {
        const lotTitle = lot[2]!
        currentLot = {
          lotSlug: slugify(lotTitle),
          title: lotTitle,
          done: lot[1]!.toLowerCase() === 'x',
          uat: [],
        }
        lots.push(currentLot)
        continue
      }
      const nested = NESTED.exec(line)
      if (nested && currentLot && /\buat\b/i.test(nested[2]!)) {
        const statement = nested[2]!
        currentLot.uat.push({
          uatSlug: slugify(statement),
          statement,
          passed: nested[1]!.toLowerCase() === 'x',
        })
      }
      // gate sub-checkboxes (no "UAT") are ignored (SPEC §5)
    }
  }

  const body = [objective.join('\n'), scope.join('\n')].filter(Boolean).join('\n\n')
  return {
    branchSlug: brSlug(title, opts.fileSlug),
    feature: { title, body },
    lots,
  }
}
