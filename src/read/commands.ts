// Lot v2.3a — transport-agnostic READ command layer. CLI and the MCP server are thin adapters over
// these pure functions: a `TrackReader` (no git/fs beyond the event log) + the SAME formatters, with
// the adapter supplying `baselineCommit` (CLI from git HEAD, MCP from a tool argument). This is what
// makes CLI≡MCP parity STRUCTURAL (one layer), not coincidental.

import { formatActionReport, formatReport, formatRows, formatWpConductor, type Format } from '../report/format.js'
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
 * The CONDUCTOR view is the 3-table FAIT / À-FAIRE(%·WP) / ATTENDUS status (the owner reports THROUGH
 * it), NOT the flat buckets too. For `json` we carry the structured `wpTree` plus the global `wpTotals`
 * so a conductor can render programmatically. If no WP forest exists, text/md falls back to legacy flat
 * buckets so unstructured repos still report useful status.
 */
export function reportText(reader: TrackReader, options: ReportOptions, format: Format): string {
  const report = reader.report(options)

  if (options.wpTree && report.wpTree !== undefined) {
    // Structured conductor view when there is an actual WP forest. JSON-first by design: presentation
    // skills/tools consume this VM and choose language, width, labels and table rendering.
    if (report.wpTree.length > 0) return formatWpConductor(report.wpTree, format, report.decisions)
    // No WP containers yet: keep the report action-oriented, not an exhaustive flat dump.
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
