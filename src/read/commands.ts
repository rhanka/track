// Lot v2.3a — transport-agnostic READ command layer. CLI and the MCP server are thin adapters over
// these pure functions: a `TrackReader` (no git/fs beyond the event log) + the SAME formatters, with
// the adapter supplying `baselineCommit` (CLI from git HEAD, MCP from a tool argument). This is what
// makes CLI≡MCP parity STRUCTURAL (one layer), not coincidental.

import { buildWpConductorView, formatActionReport, formatReport, formatRows, formatWpConductor, wpTotals, type Format } from '../report/format.js'
import type { QueryFilter, ReportOptions } from '../report/build.js'
import type { StatusLevel } from '../report/status-by-level.js'
import type { TrackReader } from './contract.js'

/**
 * `report` rendered exactly as the CLI renders it (SPEC §7).
 *
 * Default for text/md (0.19.1): a directive action report — WP/table conductor when a WP forest exists,
 * concise action/decision fallback otherwise. Use `--flat` to force the deprecated legacy bucket dump.
 * JSON stays the flat structured contract unless `--wp` is explicit.
 *
 * The CONDUCTOR view is the 3-table FAIT / À-FAIRE(%·WP) / DÉCISIONS-ACTIONS rendered for `text`/`md`.
 * For `json` the contract is UNCHANGED from 0.19.0: the additive `{...report, wpTotals}` flat structure
 * (so existing machine consumers keep working), PLUS an OPTIONAL `view` field carrying the conductor view
 * model (for presentation skills). If no WP forest exists, text/md falls back to the legacy flat buckets.
 */
export function reportText(reader: TrackReader, options: ReportOptions, format: Format): string {
  const report = reader.report(options)

  if (options.wpTree && report.wpTree !== undefined) {
    if (format === 'json') {
      // Machine contract preserved (0.19.0 shape) + additive optional `view` for skill rendering. WP-codes
      // A3: `--active-roster` is a HUMAN-render option only — JSON ALWAYS carries the full forest (every node
      // + its `terminal` flag) so a machine consumer filters terminal roots itself.
      const view = report.wpTree.length > 0 ? buildWpConductorView(report.wpTree, report.decisions ?? []) : undefined
      return `${JSON.stringify({ ...report, wpTotals: wpTotals(report.wpTree), ...(view !== undefined ? { view } : {}) }, null, 2)}\n`
    }
    // text/md: the rendered conductor tables when there is an actual WP forest. WP-codes A3 (DESIGN §A3) —
    // `--active-roster` OMITS terminal (DROPPED) ROOTS from the rendered roster. The ordinals were assigned in
    // `computeWpTree` over ALL roots, so the survivors keep their `WP<n>`/code (a gap appears) — no re-pack.
    const roster = options.activeRoster === true ? report.wpTree.filter((n) => n.terminal !== true) : report.wpTree
    if (roster.length > 0) return formatWpConductor(roster, format, report.decisions)
    // No WP containers yet (or every root filtered out): keep the report action-oriented, not a flat dump.
    return formatActionReport(report, format)
  }

  return formatReport(report, format)
}

/**
 * `report --level <spec|plan|wp|lot|task>` rendered (Scope §A/§B). `json` carries the structured status
 * groups; `text`/`md` render a one-line-per-group `done/active (pct) STATUS label — title` table. Pure
 * read over the shared `TrackReader.statusByLevel` (same path the MCP surface uses).
 */
export function statusText(
  reader: TrackReader,
  level: StatusLevel,
  options: ReportOptions,
  format: Format,
): string {
  const groups = reader.statusByLevel(level, options)
  if (format === 'json') return `${JSON.stringify({ level, groups }, null, 2)}\n`
  const head = `# status — level: ${level}\n`
  const body = groups
    .map((g) => {
      const pct = g.pct === 'n/a' ? 'n/a' : `${g.pct}%`
      return `${g.label}  ${g.done}/${g.active} (${pct})  ${g.status}${g.dropped > 0 ? ` [${g.dropped} dropped]` : ''} — ${g.title}`
    })
    .join('\n')
  return `${head}${body}${groups.length > 0 ? '\n' : ''}`
}

/** `query` rendered exactly as the CLI renders it: raw JSON for `json`, else the row formatter. */
export function queryText(
  reader: TrackReader,
  filter: QueryFilter,
  options: ReportOptions,
  format: Format,
): string {
  const rows = reader.query(filter, options)
  return format === 'json' ? `${JSON.stringify(rows, null, 2)}\n` : formatRows(rows, format)
}
