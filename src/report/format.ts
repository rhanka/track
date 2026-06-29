import { BUCKETS } from './buckets.js'
import type { DecisionRow, Report, ReportRow } from './build.js'
import type { WpNode } from './rollup.js'
import {
  buildDirectives,
  decisionNeedsFocus,
  dispatchQueueOf,
  type Directive,
  type DirectiveStepCode,
} from './directive.js'

export type Format = 'json' | 'text' | 'md'

const BACKSLASH = String.fromCharCode(92)
// Markdown metacharacters escaped in `md` titles so a user title can't inject formatting.
const MD_META = new Set([
  BACKSLASH, '`', '*', '_', '[', ']', '{', '}', '(', ')', '#', '+', '|', '<', '>', '!', '~', '-',
])

/** Collapse control characters (newlines, tabs, line separators) to single spaces. */
function clean(s: string): string {
  let out = ''
  let prevSpace = false
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    const isControlOrSpace =
      code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 || ch === ' '
    if (isControlOrSpace) {
      if (!prevSpace) {
        out += ' '
        prevSpace = true
      }
    } else {
      out += ch
      prevSpace = false
    }
  }
  return out.trim()
}

/** A display-safe title: control-normalized for text, plus markdown-metacharacter-escaped for md. */
function title(s: string, format: Format): string {
  const t = clean(s)
  if (format !== 'md') return t
  let out = ''
  for (const ch of t) out += MD_META.has(ch) ? BACKSLASH + ch : ch
  return out
}

function heading(label: string, count: number, format: Format): string {
  return format === 'md' ? `## ${label} (${count})` : `${label} (${count})`
}

function meta(r: ReportRow): string {
  return `${r.realization} · ${r.acceptance}${r.priority !== undefined ? ` · wsjf:${r.priority}` : ''}`
}

function rowLine(r: ReportRow, format: Format): string {
  return format === 'md'
    ? `- **${title(r.title, format)}** — ${meta(r)}`
    : `  - ${title(r.title, format)} [${meta(r)}]`
}

export function formatReport(report: Report, format: Format): string {
  if (format === 'json') return JSON.stringify(report, null, 2)
  const lines: string[] = []
  for (const bucket of BUCKETS) {
    const rows = report.buckets[bucket]
    lines.push(heading(bucket, rows.length, format))
    for (const r of rows) lines.push(rowLine(r, format))
    lines.push('')
  }
  if (report.decisions !== undefined) {
    lines.push(heading('DECISIONS', report.decisions.length, format))
    for (const d of report.decisions) {
      const t = title(d.title, format)
      // D6-B (WP5): surface the sponsor (= `accountable`, D6 resolved) when present. Additive — a
      // decision without a sponsor renders exactly as before (no trailing segment).
      const sponsor = d.accountable !== undefined ? ` · sponsor:${d.accountable}` : ''
      lines.push(
        format === 'md'
          ? `- **${t}** — ${d.decisionKind} · ${d.realization} · outcome:${d.outcome}${sponsor}`
          : `  - ${t} [${d.decisionKind}, ${d.realization}, outcome:${d.outcome}${d.accountable !== undefined ? `, sponsor:${d.accountable}` : ''}]`,
      )
    }
  }
  return lines.join('\n').trimEnd() + '\n'
}

const topRows = (rows: readonly ReportRow[], max: number): ReportRow[] => rows.slice(0, max)

function actionDisposition(r: ReportRow): string {
  if (r.engagementRef !== undefined) return 'relancer engagement/subagent'
  if (r.acceptance === 'fail' || r.acceptance === 'stale') return 'corriger puis revalider acceptance'
  if (r.realization === 'in-progress') return 'terminer ou expliciter blocage'
  return 'exécuter prochain incrément'
}

function decisionDisposition(d: { id: string; decisionKind: string; optionCount?: number; openQuestionCount?: number; artifacts?: readonly unknown[]; hasRecommendation?: boolean }): string {
  if (decisionNeedsFocus(d)) {
    return `focus décision HTML conseillé: track focus ${d.id} --format html`
  }
  if ((d.openQuestionCount ?? 0) > 0) return 'répondre aux questions ouvertes puis trancher'
  if (d.decisionKind === 'commitment') return 'trancher go/no-go et enregistrer outcome'
  return 'choisir l’orientation recommandée puis enregistrer outcome'
}

function cell(s: string): string {
  return clean(s).replaceAll('|', '¦')
}

function wrapCell(s: string, width: number, maxLines = 3): string[] {
  const c = cell(s).trim()
  if (c.length === 0) return ['']
  const words = c.split(/\s+/)
  const lines: string[] = []
  let line = ''
  let consumed = 0
  for (const word of words) {
    if (lines.length >= maxLines) break
    if (word.length > width) {
      if (line.length > 0) {
        lines.push(line)
        line = ''
        if (lines.length >= maxLines) break
      }
      lines.push(word.slice(0, width))
      consumed++
      continue
    }
    const next = line.length === 0 ? word : `${line} ${word}`
    if (next.length <= width) line = next
    else {
      lines.push(line)
      line = word
      if (lines.length >= maxLines) break
    }
    consumed++
  }
  if (line.length > 0 && lines.length < maxLines) lines.push(line)
  if (consumed < words.length && lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1]} ↳ détail --flat`
  return lines
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  // Terminal-first padded table: aligned columns, bounded width, MULTI-LINE cells.
  // No ellipsis: long content wraps inside the column so the report stays readable and complete enough.
  const caps = headers.map((h) => {
    const k = h.toLowerCase()
    if (k.includes('sujet') || k.includes('items') || k.includes('à faire')) return 72
    if (k.includes('préconisation') || k.includes('dernières actions')) return 64
    if (k.includes('complexité') || k.includes('notes') || k.includes('dropped')) return 38
    if (k.includes('scope') || k.includes('wp')) return 42
    return 24
  })
  const head = headers.map((h, i) => cell(h).slice(0, caps[i]!))
  const wrappedRows = rows.map((row) => headers.map((_, i) => wrapCell(row[i] ?? '', caps[i]!)))
  const widths = head.map((h, i) => Math.min(caps[i]!, Math.max(h.length, ...wrappedRows.flatMap((r) => r[i]!).map((v) => v.length))))
  const renderLine = (row: readonly string[]): string => row.map((v, i) => v.padEnd(widths[i]!)).join('   ')
  const out = [renderLine(head), renderLine(widths.map((w) => '─'.repeat(w)))]
  for (const row of wrappedRows) {
    const height = Math.max(...row.map((cellLines) => cellLines.length))
    for (let y = 0; y < height; y++) out.push(renderLine(row.map((cellLines) => cellLines[y] ?? '')))
    out.push('') // breathing room between logical rows
  }
  if (out[out.length - 1] === '') out.pop()
  return out
}

/**
 * Directive fallback for repos that have no WP containers yet. This is intentionally NOT the exhaustive
 * flat dump: it keeps the “decision/action recommendation” spirit while `--flat` remains available for
 * the full bucket listing.
 */
export function formatActionReport(report: Report, format: Format): string {
  if (format === 'json') return JSON.stringify(report, null, 2)
  const h = (label: string): string => (format === 'md' ? `## ${label}` : label)
  const lines: string[] = []
  const awaited = report.buckets.AWAITED
  const todo = report.buckets['TO-DO']
  const done = report.buckets.DONE
  const dropped = report.buckets.DROPPED
  const pendingDecisions = report.decisions?.filter((d) => d.outcome === 'pending') ?? []

  lines.push(h('SYNTHÈSE'))
  lines.push(...table(['fait', 'à-faire', 'attendus', 'dropped', 'décisions pending'], [[String(done.length), String(todo.length), String(awaited.length), String(dropped.length), String(pendingDecisions.length)]]))
  lines.push('')

  lines.push(h('DÉCISIONS/ACTIONS'))
  const candidates = [...awaited, ...todo].slice(0, 10)
  const actionRows: string[][] = []
  const focusCount = pendingDecisions.filter(decisionNeedsFocus).length
  if (focusCount >= 2 || pendingDecisions.length >= 4) {
    actionRows.push(['focus', 'décisions accumulées', 'focus (humain+MCP): lancer focus HTML local; retour outcome via vue interactive/MCP'])
  }
  for (const d of pendingDecisions.slice(0, 8)) {
    actionRows.push([
      d.decisionKind,
      title(d.title, format),
      `décision (${d.accountable ?? 'owner'}): ${decisionDisposition(d)}`,
    ])
  }
  for (const r of candidates) {
    actionRows.push([
      r.bucket,
      title(r.title, format),
      `action (${r.engagementRef !== undefined ? 'h2a/subagent' : 'local/subagent'}): ${actionDisposition(r)}`,
    ])
  }
  lines.push(...table(['scope/gate', 'sujet', 'préconisation'], actionRows.length > 0 ? actionRows : [['-', 'aucune décision/action ouverte', '-']]))
  lines.push('')

  lines.push(h('FAIT RÉCENT / REPÈRES'))
  const doneRows = topRows(done, 5).map((r) => ['done', title(r.title, format), r.acceptance])
  if (done.length > 5) doneRows.push(['info', `${done.length - 5} autres done; utiliser --flat pour le détail complet`, ''])
  if (dropped.length > 0) doneRows.push(['dropped', `${dropped.length}; utiliser --flat pour audit`, ''])
  lines.push(...table(['type', 'sujet', 'acceptance'], doneRows.length > 0 ? doneRows : [['-', 'aucun repère récent', '-']]))

  return lines.join('\n').trimEnd() + '\n'
}

const pctStr = (p: number | 'n/a'): string => (p === 'n/a' ? 'n/a' : `${p}%`)

/**
 * Strip a redundant leading `WPn — `/`WPn · `/`WPn -` prefix the WP item TITLE may already carry, so
 * the renderer's derived `${label} · ` is never doubled (`WP1 · WP1 — …`). Case-insensitive on `WP`,
 * tolerant of `—`/`·`/`-` separators and surrounding spaces; a title with no such prefix is unchanged.
 */
function stripWpPrefix(s: string): string {
  return s.replace(/^WP\d+(?:\.\d+)*\s*[—·-]\s*/i, '')
}

/**
 * Render the WP rollup forest in agent-stats' shape (Workpackages §2):
 *   - **WP1 · <title>** (done/total, pct%)
 *     - **WP1.1 · <title>** (done/total, pct%)
 *       - [x] <leaf>   / [ ] <leaf>
 * `total` = `active` (DONE+TO-DO+AWAITED); DROPPED leaves are shown with `[~]` and excluded from %.
 * `pct` is `n/a` for a 0/0 node (never 100%). `format` gates escaping — `md` escapes markdown
 * metacharacters (no formatting injection); `text` is CLEAN (no backslash leaks). Defaults to `md`.
 */
export function formatWpTree(tree: readonly WpNode[], format: Format = 'md'): string {
  const lines: string[] = []
  const bold = (s: string): string => (format === 'md' ? `**${s}**` : s)
  const render = (node: WpNode, depth: number): void => {
    const indent = '  '.repeat(depth)
    const label = `${node.label} · ${title(stripWpPrefix(node.title), format)}`
    lines.push(`${indent}- ${bold(label)} (${node.done}/${node.active}, ${pctStr(node.pct)})`)
    for (const leaf of node.leaves) {
      const box = leaf.bucket === 'DONE' ? '[x]' : leaf.bucket === 'DROPPED' ? '[~]' : '[ ]'
      lines.push(`${indent}  - ${box} ${title(leaf.title, format)}`)
    }
    for (const child of node.children) render(child, depth + 1)
  }
  for (const node of tree) render(node, 0)
  return lines.join('\n') + (lines.length > 0 ? '\n' : '')
}

/** Global totals — the SUM of every WP node's directly-attached leaves across the forest (no double-count). */
export interface WpTotals {
  done: number
  active: number
  dropped: number
  pct: number | 'n/a'
}

/**
 * Sum the forest's leaves ONCE: every non-WP leaf is attached to exactly one node (`directLeaves`
 * stops at sub-WP boundaries), so a flat walk over `node.leaves` is the true global total — never the
 * roots' rolled-up counts (which would double-count nested sub-WP leaves).
 */
export function wpTotals(tree: readonly WpNode[]): WpTotals {
  let done = 0
  let active = 0
  let dropped = 0
  const walk = (node: WpNode): void => {
    for (const l of node.leaves) {
      if (l.bucket === 'DONE') {
        done++
        active++
      } else if (l.bucket === 'AWAITED' || l.bucket === 'TO-DO') {
        active++
      } else dropped++
    }
    for (const c of node.children) walk(c)
  }
  for (const node of tree) walk(node)
  return { done, active, dropped, pct: active === 0 ? 'n/a' : Math.round((done / active) * 100) }
}

/** Open (non-DONE, non-DROPPED) leaves under a node — what À-FAIRE lists as `◦ <title>`. */
function openLeaves(node: WpNode): WpNode['leaves'] {
  const out: WpNode['leaves'] = []
  const walk = (n: WpNode): void => {
    for (const l of n.leaves) if (l.bucket === 'TO-DO' || l.bucket === 'AWAITED') out.push(l)
    for (const c of n.children) walk(c)
  }
  walk(node)
  return out
}

/** DROPPED leaves under a node — shown aside in À-FAIRE, excluded from %. */
function droppedLeaves(node: WpNode): WpNode['leaves'] {
  const out: WpNode['leaves'] = []
  const walk = (n: WpNode): void => {
    for (const l of n.leaves) if (l.bucket === 'DROPPED') out.push(l)
    for (const c of n.children) walk(c)
  }
  walk(node)
  return out
}

/**
 * Report-revamp — the 3-table CONDUCTOR view over the WP forest (the owner reports THROUGH this):
 *   FAIT             — WPs at 100% + a global done/total, pct%.
 *   À-FAIRE (%·WP)   — one row per non-100% WP `WPn · title — done/active pct%`, then its OPEN leaves
 *                      (`◦ <title>`); DROPPED shown aside.
 *   ATTENDUS         — AWAITED (blocked) leaves carrying a derived disposition tag
 *                      (`décision: owner` when AWAITED-on-a-decision or carrying an open engagementRef,
 *                      else `action: agent`).
 * `format` gates escaping (md escapes; text is clean). The forest's leaves drive every section.
 */
export interface ReportViewTable {
  id: string
  title: string
  columns: readonly { id: string; label: string }[]
  rows: readonly Record<string, string>[]
}

export interface ReportView {
  kind: 'wp-conductor-report'
  locale: 'fr'
  tables: readonly ReportViewTable[]
  generalRecommendation: string
  /**
   * preconisation-actionnable (DESIGN §4) — the langue-neutre DIRECTIVES the tables are DERIVED from
   * (machine surface). `dispatchQueue` is the flat, prioritized list of SUBAGENT directive ids (the real
   * delegation payload). Both are additive; the rendered tables + `generalRecommendation` stay back-compat.
   */
  directives: readonly Directive[]
  dispatchQueue: readonly string[]
}

/**
 * Render ONE directive to a human FR phrase — RENDER-ONLY (no phrase is ever stored as data, DESIGN §3).
 * Maps the langue-neutre `(mode, step, gate)` to a sentence. An UNKNOWN `step.code` (a future vocabulary
 * entry this renderer predates) degrades to the `inspect-fallback` phrasing — forward-compat (DESIGN §7).
 */
export function directivePhrase(d: Directive): string {
  if (d.mode === 'human-decision') {
    const who = d.facts.accountable ?? 'owner'
    return d.step.code === 'focus-decision'
      ? `décision (${who}): focus dossier (questions/options) puis trancher outcome`
      : `décision (${who}): trancher outcome`
  }
  if (d.mode === 'h2a-engagement') {
    return 'engagement (h2a): relancer engagement puis intégrer le retour'
  }
  const mode = d.mode === 'local' ? 'local' : 'subagent'
  const phrase: Record<DirectiveStepCode, string> = {
    'focus-decision': `action (${mode}): focus dossier puis trancher outcome`,
    'settle-decision': `action (${mode}): trancher outcome`,
    'resume-engagement': `action (${mode}): relancer engagement puis intégrer le retour`,
    'resolve-external-blocker': `action (${mode}): lever le blocage puis reprendre`,
    'amend-spec': `action (${mode}): spécifier avant de démarrer`,
    'fix-acceptance': `action (${mode}): corriger puis revalider acceptance (fail)`,
    'rerun-acceptance': `action (${mode}): relancer acceptance (stale) sur le commit courant`,
    'finish-increment': `action (${mode}): terminer l'incrément en cours`,
    'start-increment': `action (${mode}): continuer le premier item ouvert puis enregistrer preuve/acceptance`,
    'prioritize-backlog': `action (${mode}): prioriser le backlog (WSJF absent) puis reprendre`,
    'inspect-fallback': `action (${mode}): inspecter l'état puis décider la suite`,
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition — `step.code` may be an UNKNOWN
  // future vocabulary entry (governed/additive enums): fall back rather than render `undefined`.
  return phrase[d.step.code] ?? `action (${mode}): inspecter l'état puis décider la suite`
}

/** The `scope/gate` cell for a directive row: its gate code if any, else the WP label, else `-`. */
function directiveScopeLabel(d: Directive): string {
  return d.gate?.code ?? d.scope.wpLabel ?? '-'
}

export function buildWpConductorView(tree: readonly WpNode[], decisions: readonly DecisionRow[] = []): ReportView {
  const wpName = (n: WpNode): string => `${n.label} · ${clean(stripWpPrefix(n.title))}`
  const totals = wpTotals(tree)

  // preconisation-actionnable (DESIGN §4): the DÉCISIONS/ACTIONS table + generalRecommendation are now
  // DERIVED from the directive set (each directive ⇒ one row, phrase rendered, never stored). FAIT/À-FAIRE
  // stay the same rollup-driven tables (unchanged back-compat).
  const directives = buildDirectives(tree, decisions)
  const dispatchQueue = dispatchQueueOf(directives)
  const humanDecisions = directives.filter((d) => d.mode === 'human-decision')
  const focusNeeded = humanDecisions.filter((d) => d.step.code === 'focus-decision').length
  const generalRecommendation = focusNeeded >= 2 || humanDecisions.length >= 4
    ? 'Prévoir un temps de focus HTML pour trancher les décisions accumulées, puis reprendre les WP par premier item ouvert.'
    : 'Avancer par premier item ouvert, enregistrer preuve/acceptance, et escalader uniquement les décisions réellement bloquantes.'

  const doneRows: Record<string, string>[] = [
    { scope: 'global', progress: `${totals.done}/${totals.active} (${pctStr(totals.pct)})`, lastActions: `${totals.done} items faits; poursuivre les WP ouverts` },
    ...tree.filter((n) => n.pct === 100).map((n) => ({ scope: wpName(n), progress: `${n.done}/${n.active} (100%)`, lastActions: 'WP clos; preuve/acceptance enregistrée' })),
  ]

  const todoRows = tree.filter((n) => n.pct !== 100).map((n) => {
    const open = openLeaves(n)
    const shown = open.slice(0, 2).map((l) => clean(l.title)).join(' / ')
    // NEVER truncate silently: surface the count of items not shown so the report can't read as complete.
    const more = open.length > 2 ? `${shown} (+${open.length - 2} autres)` : shown
    return { wp: wpName(n), progress: `${n.done}/${n.active} (${pctStr(n.pct)})`, todo: more || 'aucun item ouvert direct' }
  })

  // DÉCISIONS/ACTIONS rows — derived from the directives. Decisions first (capped at 8 + an omission count
  // so the table never reads as complete when it isn't), then engagement/work directives.
  const actionRows: Record<string, string>[] = []
  if (focusNeeded >= 2 || humanDecisions.length >= 4) {
    actionRows.push({ scope: '-', subject: 'décisions accumulées', recommendation: 'focus (humain+MCP): lancer focus HTML local; retour outcome via vue interactive/MCP' })
  }
  for (const d of humanDecisions.slice(0, 8)) {
    actionRows.push({ scope: directiveScopeLabel(d), subject: clean(d.target.title ?? d.target.id), recommendation: directivePhrase(d) })
  }
  for (const d of directives.filter((x) => x.mode !== 'human-decision')) {
    actionRows.push({ scope: directiveScopeLabel(d), subject: clean(d.target.title ?? d.target.id), recommendation: directivePhrase(d) })
  }
  const omitted = Math.max(0, humanDecisions.length - 8)
  if (omitted > 0) {
    actionRows.push({ scope: '-', subject: `+${omitted} entrées non listées`, recommendation: 'voir `track query` / `track report --flat` pour le détail complet' })
  }

  return {
    kind: 'wp-conductor-report',
    locale: 'fr',
    tables: [
      { id: 'done', title: 'FAIT', columns: [{ id: 'scope', label: 'scope' }, { id: 'progress', label: 'avancement' }, { id: 'lastActions', label: 'dernières actions' }], rows: doneRows },
      { id: 'todo', title: 'À-FAIRE', columns: [{ id: 'wp', label: 'WP' }, { id: 'progress', label: 'avancement' }, { id: 'todo', label: 'à faire' }], rows: todoRows.length > 0 ? todoRows : [{ wp: '-', progress: '-', todo: 'aucun WP ouvert' }] },
      { id: 'decisions-actions', title: 'DÉCISIONS/ACTIONS', columns: [{ id: 'scope', label: 'scope/gate' }, { id: 'subject', label: 'sujet' }, { id: 'recommendation', label: 'préconisation' }], rows: actionRows.length > 0 ? actionRows : [{ scope: '-', subject: 'aucune action ouverte dans les WP actifs', recommendation: '-' }] },
    ],
    generalRecommendation,
    directives,
    dispatchQueue,
  }
}

function renderReportView(view: ReportView, format: Format): string {
  if (format === 'json') return JSON.stringify(view, null, 2) + '\n'
  // User-originated cell content (titles) is escaped per-format: `md` escapes markdown metacharacters so a
  // crafted item title cannot inject formatting (parity with the legacy `formatReport`/`title` path); `text`
  // is clean. The view model itself stays RAW (escaping is a render-only concern).
  const esc = (s: string): string => title(s, format)
  const h = (label: string): string => (format === 'md' ? `## ${label}` : label)
  const lines: string[] = []
  for (const section of view.tables) {
    lines.push(h(section.title))
    lines.push(...table(section.columns.map((c) => c.label), section.rows.map((row) => section.columns.map((c) => esc(row[c.id] ?? '')))))
    lines.push('')
  }
  lines.push(h('RECOMMANDATION'))
  lines.push(esc(view.generalRecommendation))
  return lines.join('\n').trimEnd() + '\n'
}

export function formatWpConductor(tree: readonly WpNode[], format: Format, decisions: readonly DecisionRow[] = []): string {
  return renderReportView(buildWpConductorView(tree, decisions), format)
}

export function formatRows(rows: ReportRow[], format: Format): string {
  if (format === 'json') return JSON.stringify(rows, null, 2)
  if (rows.length === 0) return ''
  return (
    rows
      .map((r) =>
        format === 'md'
          ? `- **${title(r.title, format)}** — ${r.bucket} · ${r.realization} · ${r.acceptance}`
          : `  - ${title(r.title, format)} [${r.bucket}, ${r.realization}, ${r.acceptance}]`,
      )
      .join('\n') + '\n'
  )
}
