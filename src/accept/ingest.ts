import type { RunResult } from '../model/acceptance.js'

export type RunReportFormat = 'junit' | 'json'

export interface RunReportEntry {
  locator: string
  result: RunResult
}

/**
 * Parse a test report into `{locator, result}` entries (SPEC §6 `accept run --from`). Minimal,
 * dependency-free: JUnit XML (`<testcase name>` + `<failure>`/`<error>` ⇒ fail; `<skipped>` ⇒
 * omitted) and a simple JSON form (array, or `{results:[…]}`, of `{locator|name, result|status}`).
 *
 * Only an EXPLICIT pass/fail produces a run; an unknown/skipped/errored/empty-locator entry is
 * OMITTED (never recorded as a pass), so an inconclusive report can never make acceptance green.
 */
export function parseRunReport(content: string, format: RunReportFormat): RunReportEntry[] {
  return format === 'junit' ? parseJunit(content) : parseJson(content)
}

function parseJunit(content: string): RunReportEntry[] {
  const entries: RunReportEntry[] = []
  const testcase = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
  let match: RegExpExecArray | null
  while ((match = testcase.exec(content)) !== null) {
    const attrs = match[1] ?? ''
    // Strip CDATA so XML-like text inside a body cannot be misread as a <failure>/<error> element.
    const body = (match[3] ?? '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    if (/<skipped\b/.test(body)) continue // a skipped test is not a run
    const name = /\bname\s*=\s*"([^"]*)"/.exec(attrs)
    const locator = name?.[1] ?? ''
    if (locator === '') continue
    const failed = /<(failure|error)\b/.test(body)
    entries.push({ locator, result: failed ? 'fail' : 'pass' })
  }
  return entries
}

function normalizeResult(status: unknown): RunResult | undefined {
  if (status === 'pass' || status === 'passed') return 'pass'
  if (status === 'fail' || status === 'failed') return 'fail'
  return undefined // unknown / skipped / errored / missing → omit
}

function parseJson(content: string): RunReportEntry[] {
  const data = JSON.parse(content) as unknown
  const list: unknown[] = Array.isArray(data)
    ? data
    : typeof data === 'object' &&
        data !== null &&
        Array.isArray((data as { results?: unknown }).results)
      ? (data as { results: unknown[] }).results
      : []
  const entries: RunReportEntry[] = []
  for (const raw of list) {
    const r = raw as { locator?: unknown; name?: unknown; result?: unknown; status?: unknown }
    const locator = String(r.locator ?? r.name ?? '')
    if (locator === '') continue
    const result = normalizeResult(r.result ?? r.status)
    if (result === undefined) continue
    entries.push({ locator, result })
  }
  return entries
}
