// Lot v2.3a — read-only MCP server over the shared read command layer (read/commands.ts +
// TrackReader). Thin adapter: every tool maps 1:1 to a read on a baseline the CALLER supplies
// (no git in this layer). Read tools are side-effect-free — they never append to the event log.
//
// The low-level Server does NOT auto-validate args against the advertised inputSchema, so this
// module validates every arg itself (enum + type) and surfaces violations as `isError` — matching
// the CLI's `oneOf` strictness so the two transports never diverge on bad input.

import { join } from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { resolveTrackDirOrNull, type ResolveOptions } from '../cli/resolve.js'
import { queryText, reportText } from '../read/commands.js'
import { TrackReader } from '../read/contract.js'
import type { QueryFilter, ReportOptions } from '../report/build.js'
import { VERSION } from '../version.js'

// Allowed enum values — the single source for BOTH the advertised schema and runtime validation.
const KINDS = ['feature', 'bug', 'chore'] as const
const ROLES = ['workpackage'] as const // Workpackages §2 — container marker filter
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
        role: { type: 'string', enum: ROLES },
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
  {
    name: 'track_external_deps',
    description: 'Open external (scope:extra) dependencies awaiting an h2a ENGAGEMENT, as JSON [{blockerId, targetId, engagementRef, openedAt}]. What an h2a bridge watches to resolve when an engagement settles.',
    inputSchema: { type: 'object', properties: {} },
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
      const role = optEnum(args, 'role', ROLES)
      if (role !== undefined) filter.role = role
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
    case 'track_external_deps':
      return JSON.stringify(reader.externalDependencies(), null, 2)
    case 'track_branch_provenance':
      return JSON.stringify(reader.branchProvenance(reqStr(args, 'locator')) ?? null, null, 2)
    case 'track_freshness':
      return JSON.stringify(reader.freshness(reqStr(args, 'content'), reqStr(args, 'locator')), null, 2)
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

/**
 * Per-call read binding: the `TrackReader` to dispatch against, plus an optional serve-empty `hint`.
 * When a `.track` resolves, `hint` is undefined and reads run against the real log. When none resolves
 * (an unadopted repo), the reader points at a NONEXISTENT path — `EventStore.readAll()`→`[]` /
 * `readHead`→`null` already yield the honest-empty payloads (empty buckets, `[]`, `{ok:true}`, null,
 * `{status:'absent'}`) — and `hint` carries an actionable `track init` line as additive transport
 * content (NOT embedded in the JSON schema). Resolution is LAZY (per call) so a `.track` created after
 * boot is picked up without a restart. A bad EXPLICIT override throws here → surfaced as `isError`.
 */
interface ReadBinding {
  reader: TrackReader
  hint?: string
}

/** Build a read-only MCP server. Accepts a fixed `eventsPath` (tests) or `ResolveOptions` (lazy serve). */
export function createTrackMcpServer(source: string | ResolveOptions): Server {
  // Fixed-path form (existing test API): bind one reader, never a hint.
  // Lazy form (`track-mcp` boot): resolve the store per call so post-boot `track init` is seen.
  const bind: () => ReadBinding =
    typeof source === 'string'
      ? () => ({ reader: new TrackReader(source) })
      : () => {
          const trackDir = resolveTrackDirOrNull(source) // throws on a bad explicit override (stays loud)
          if (trackDir === null) {
            return {
              reader: new TrackReader(join(source.cwd, '.track', 'events.jsonl')), // nonexistent ⇒ empty
              hint: `No .track resolved from ${source.cwd}. Run \`track init\` to create one (the ONLY command that does), or pass --track-dir / TRACK_DIR. Serving an empty view.`,
            }
          }
          return { reader: new TrackReader(join(trackDir, 'events.jsonl')) }
        }

  const server = new Server(
    { name: '@sentropic/track', version: VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: READ_TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args } = request.params
    let binding: ReadBinding
    try {
      binding = bind() // a bad explicit override throws here → loud isError, not a silent empty-serve
      const text = dispatchReadTool(binding.reader, name, (args ?? {}) as Record<string, unknown>)
      const content = [{ type: 'text' as const, text }]
      // Additive transport hint on a serve-empty read — never embedded in the payload JSON.
      if (binding.hint !== undefined) content.push({ type: 'text' as const, text: binding.hint })
      return { content }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  })

  return server
}
