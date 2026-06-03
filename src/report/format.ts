import { BUCKETS } from './buckets.js'
import type { Report, ReportRow } from './build.js'

export type Format = 'json' | 'text' | 'md'

function heading(label: string, count: number, format: Format): string {
  return format === 'md' ? `## ${label} (${count})` : `${label} (${count})`
}

function meta(r: ReportRow): string {
  return `${r.realization} · ${r.acceptance}${r.priority !== undefined ? ` · wsjf:${r.priority}` : ''}`
}

function rowLine(r: ReportRow, format: Format): string {
  return format === 'md' ? `- **${r.title}** — ${meta(r)}` : `  - ${r.title} [${meta(r)}]`
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
      lines.push(
        format === 'md'
          ? `- **${d.title}** — ${d.decisionKind} · ${d.realization} · outcome:${d.outcome}`
          : `  - ${d.title} [${d.decisionKind}, ${d.realization}, outcome:${d.outcome}]`,
      )
    }
  }
  return lines.join('\n').trimEnd() + '\n'
}

export function formatRows(rows: ReportRow[], format: Format): string {
  if (format === 'json') return JSON.stringify(rows, null, 2)
  if (rows.length === 0) return ''
  return (
    rows
      .map((r) =>
        format === 'md'
          ? `- **${r.title}** — ${r.bucket} · ${r.realization} · ${r.acceptance}`
          : `  - ${r.title} [${r.bucket}, ${r.realization}, ${r.acceptance}]`,
      )
      .join('\n') + '\n'
  )
}
