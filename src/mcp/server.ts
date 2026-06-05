// Lot v2.3a — read-only MCP server over the shared read command layer (read/commands.ts +
// TrackReader). Thin adapter: every tool maps 1:1 to a read on a baseline the CALLER supplies
// (no git in this layer). Read tools are side-effect-free — they never append to the event log.
//
// The low-level Server does NOT auto-validate args against the advertised inputSchema, so this
// module validates every arg itself (enum + type) and surfaces violations as `isError` — matching
// the CLI's `oneOf` strictness so the two transports never diverge on bad input.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { queryText, reportText } from '../read/commands.js'
import { TrackReader } from '../read/contract.js'
import type { QueryFilter, ReportOptions } from '../report/build.js'
import { VERSION } from '../version.js'

// Allowed enum values — the single source for BOTH the advertised schema and runtime validation.
const KINDS = ['feature', 'bug', 'chore'] as const
const BUCKETS = ['AWAITED', 'DROPPED', 'DONE', 'TO-DO'] as const
const REALIZATIONS = ['to-do', 'in-progress', 'done', 'cancelled', 'rejected'] as const
const ACCEPTANCES = ['pass', 'fail', 'unknown', 'stale', 'waived'] as const

/** Read-only tools, declared as plain JSON Schema (no zod) — the curated read contract over MCP. */
export const READ_TOOLS = [
  {
    name: 'track_report',
    description: 'Bucketed backlog report (AWAITED/DROPPED/DONE/TO-DO) as JSON. AWAITED is relative to baselineCommit.',
    inputSchema: {
      type: 'object',
      properties: {
        baselineCommit: { type: 'string', description: 'Commit the report is evaluated against (acceptance/staleness).' },
        requireAccepted: { type: 'boolean', description: 'A done item counts as DONE only if acceptance=pass.' },
        decisions: { type: 'boolean', description: 'Include the decisions view.' },
      },
      required: ['baselineCommit'],
    },
  },
  {
    name: 'track_query',
    description: 'Flat, filtered query over the non-decision report rows, as JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        baselineCommit: { type: 'string' },
        kind: { type: 'string', enum: KINDS },
        workspace: { type: 'string' },
        bucket: { type: 'string', enum: BUCKETS },
        realization: { type: 'string', enum: REALIZATIONS },
        acceptance: { type: 'string', enum: ACCEPTANCES },
      },
      required: ['baselineCommit'],
    },
  },
  {
    name: 'track_validate',
    description: 'Recompute the append-only integrity chain (detect-only). Returns {ok, findings}. NOTE: integrity only — unlike the CLI `validate`, it does NOT include prose↔log desync (that would read arbitrary cwd files, breaking the read-only contract).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'track_branch_provenance',
    description: 'Latest branch.imported provenance for a BRANCH.md locator (or null).',
    inputSchema: {
      type: 'object',
      properties: { locator: { type: 'string' } },
      required: ['locator'],
    },
  },
  {
    name: 'track_freshness',
    description: 'Is the sidecar structurally current with the given BRANCH.md content for a locator?',
    inputSchema: {
      type: 'object',
      properties: { locator: { type: 'string' }, content: { type: 'string' } },
      required: ['locator', 'content'],
    },
  },
] as const

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new Error(`tool argument "${key}" must be a string`)
  return v
}

function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw new Error(`tool argument "${key}" must be a boolean`)
  return v
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new Error(`tool argument "${key}" must be a string`)
  return v
}

function optEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new Error(`tool argument "${key}" must be one of: ${allowed.join(', ')}`)
  }
  return v as T
}

/**
 * Pure tool dispatch — used by both the server handler and the parity test. Returns the tool's
 * text payload (JSON), identical to the CLI's `--format json` output for report/query. Throws on a
 * missing/invalid argument (the handler turns the throw into an MCP `isError` result).
 */
export function dispatchReadTool(
  reader: TrackReader,
  name: string,
  args: Record<string, unknown>,
): string {
  switch (name) {
    case 'track_report': {
      const options: ReportOptions = {
        baselineCommit: reqStr(args, 'baselineCommit'),
        requireAccepted: optBool(args, 'requireAccepted') ?? false,
        decisions: optBool(args, 'decisions') ?? false,
      }
      return reportText(reader, options, 'json')
    }
    case 'track_query': {
      const filter: QueryFilter = {}
      const kind = optEnum(args, 'kind', KINDS)
      if (kind !== undefined) filter.kind = kind
      const workspace = optStr(args, 'workspace')
      if (workspace !== undefined) filter.workspace = workspace
      const bucket = optEnum(args, 'bucket', BUCKETS)
      if (bucket !== undefined) filter.bucket = bucket
      const realization = optEnum(args, 'realization', REALIZATIONS)
      if (realization !== undefined) filter.realization = realization
      const acceptance = optEnum(args, 'acceptance', ACCEPTANCES)
      if (acceptance !== undefined) filter.acceptance = acceptance
      return queryText(reader, filter, { baselineCommit: reqStr(args, 'baselineCommit') }, 'json')
    }
    case 'track_validate':
      return JSON.stringify(reader.validate(), null, 2)
    case 'track_branch_provenance':
      return JSON.stringify(reader.branchProvenance(reqStr(args, 'locator')) ?? null, null, 2)
    case 'track_freshness':
      return JSON.stringify(reader.freshness(reqStr(args, 'content'), reqStr(args, 'locator')), null, 2)
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

/** Build a read-only MCP server bound to one `.track/events.jsonl`. */
export function createTrackMcpServer(eventsPath: string): Server {
  const reader = new TrackReader(eventsPath)
  const server = new Server(
    { name: '@sentropic/track', version: VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: READ_TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args } = request.params
    try {
      const text = dispatchReadTool(reader, name, (args ?? {}) as Record<string, unknown>)
      return { content: [{ type: 'text' as const, text }] }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  })

  return server
}
