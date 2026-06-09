// Lot v2.3a — transport-agnostic READ command layer. CLI and the MCP server are thin adapters over
// these pure functions: a `TrackReader` (no git/fs beyond the event log) + the SAME formatters, with
// the adapter supplying `baselineCommit` (CLI from git HEAD, MCP from a tool argument). This is what
// makes CLI≡MCP parity STRUCTURAL (one layer), not coincidental.

import { formatReport, formatRows, formatWpConductor, wpTotals, type Format } from '../report/format.js'
import type { QueryFilter, ReportOptions } from '../report/build.js'
import type { TrackReader } from './contract.js'

/**
 * `report` rendered exactly as the CLI renders it (SPEC §7).
 *
 * Default (no `--wp`): the flat bucket dump, unchanged (back-compat).
 *
 * `--wp` (report-revamp): the CONDUCTOR view ONLY — the 3-table FAIT / À-FAIRE(%·WP) / ATTENDUS
 * status (the owner reports THROUGH it), NOT the flat buckets too. For `json` we carry the structured
 * `wpTree` plus the global `wpTotals` so a conductor can render programmatically.
 */
export function reportText(reader: TrackReader, options: ReportOptions, format: Format): string {
  const report = reader.report(options)

  if (options.wpTree && report.wpTree !== undefined) {
    if (format === 'json') {
      // Additive: emit the whole report (buckets stay for back-compat) plus the global WP totals.
      return `${JSON.stringify({ ...report, wpTotals: wpTotals(report.wpTree) }, null, 2)}\n`
    }
    // Structured view ONLY — no flat bucket dump in --wp mode.
    return formatWpConductor(report.wpTree, format)
  }

  return formatReport(report, format)
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
