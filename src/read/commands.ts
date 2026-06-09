// Lot v2.3a — transport-agnostic READ command layer. CLI and the MCP server are thin adapters over
// these pure functions: a `TrackReader` (no git/fs beyond the event log) + the SAME formatters, with
// the adapter supplying `baselineCommit` (CLI from git HEAD, MCP from a tool argument). This is what
// makes CLI≡MCP parity STRUCTURAL (one layer), not coincidental.

import { formatReport, formatRows, formatWpTree, type Format } from '../report/format.js'
import type { QueryFilter, ReportOptions } from '../report/build.js'
import type { TrackReader } from './contract.js'

/**
 * `report` rendered exactly as the CLI renders it (SPEC §7). When `options.wpTree` is set, the
 * Workpackages §2 rollup is appended (Markdown for text/md; carried on `report.wpTree` for json).
 */
export function reportText(reader: TrackReader, options: ReportOptions, format: Format): string {
  const report = reader.report(options)
  const base = formatReport(report, format)
  if (!options.wpTree || report.wpTree === undefined || format === 'json') return base
  const tree = formatWpTree(report.wpTree)
  if (tree.length === 0) return base
  const heading = format === 'md' ? '## WORKPACKAGES' : 'WORKPACKAGES'
  return `${base}\n${heading}\n${tree}`
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
