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
import { queryText, reportText, statusText } from '../read/commands.js'
import { TrackReader } from '../read/contract.js'
import type { QueryFilter, ReportOptions } from '../report/build.js'
import { VERSION } from '../version.js'

// Allowed enum values — the single source for BOTH the advertised schema and runtime validation.
const KINDS = ['feature', 'bug', 'chore'] as const
const ROLES = ['workpackage', 'spec-phase', 'stream'] as const // Scope §B(a) / A2 — the 3 container marker filters
const BUCKETS = ['AWAITED', 'DROPPED', 'DONE', 'TO-DO'] as const
const REALIZATIONS = ['to-do', 'in-progress', 'done', 'cancelled', 'rejected'] as const
const ACCEPTANCES = ['pass', 'fail', 'unknown', 'stale', 'waived'] as const
const LEVELS = ['spec', 'plan', 'wp', 'lot', 'task'] as const // Scope §A/§B — status(level) tiers

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
    name: 'track_audit',
    description: 'DESIGN R4 — deterministic structural audit over the folded log, as JSON AuditFinding[] (orphan, empty-wp, duplicate, cross-workspace-subtree, singleton-workspace). PURE, read-only, no clock; byte-identical to the CLI `audit --format json`. `severity` action=resolve via the restructuration plan flow, info=expected/structural.',
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
  {
    name: 'track_status',
    description: 'status(level) projection (Scope §A/§B): rolls leaf buckets up to a scope tier {spec|plan|wp|lot|task}, as JSON {level, groups:[{id,title,label,depth,status,done,active,dropped,pct}]}. wp ≡ the computeWpTree forest; task = leaf buckets; lot|plan|spec = the same rollup over WP-nesting tiers (SUM not mean; dropped excluded; 0/0⇒n/a). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: LEVELS, description: 'The scope tier to roll up to.' },
        baselineCommit: { type: 'string', description: 'Commit AWAITED/acceptance are evaluated against.' },
        requireAccepted: { type: 'boolean', description: 'A done leaf counts as DONE only if acceptance=pass.' },
      },
      required: ['level', 'baselineCommit'],
    },
  },
  {
    name: 'track_verification_runs',
    description: 'Recorded path-scope VerificationRuns (Scope §B(c)) — the EVIDENCE a future `scope validate` reads, as JSON [{runId,runner,commit,env?,verdict,wpRef?,violations?,at}]. EVIDENCE-ONLY: a path verdict never becomes an item. `violations` are the harness verbatim offending paths (track never glob-matches). Optional `wpRef` filters to one WP/phase.',
    inputSchema: {
      type: 'object',
      properties: { wpRef: { type: 'string', description: 'Filter to runs for this WP/phase item id.' } },
    },
  },
  {
    name: 'track_scope_validate',
    description: 'Scope §B(b) — PURE, read-only, fail-closed, ADVISORY scope validation, as JSON {status:pass|fail|stale|missing, findings[], perWp[], scopeRevisionHash?}. NEVER glob-matches (string-level set logic), NEVER ingests, NEVER a commit gate. Flags scope-undeclared / incoherent (allowed∩forbidden) / illegal-nesting / claim-out-of-phase, and surfaces the latest ingested VerificationRun verdict per WP (read, never recomputed). If `content`+`locator` are supplied, requireFresh runs FIRST (a stale/altered/not-imported sidecar ⇒ status:stale, no partial verdict). Optional opt-in inferDeliveredOutOfScope.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'The workspace whose WP/spec-phase scope is validated.' },
        baselineCommit: { type: 'string', description: 'Commit AWAITED/realization-active are evaluated against.' },
        content: { type: 'string', description: 'Live BRANCH.md content for the fail-closed freshness gate (with locator).' },
        locator: { type: 'string', description: 'BRANCH.md locator for the fail-closed freshness gate (with content).' },
        claimedItemId: { type: 'string', description: 'Optional claimed item id — flagged if not a descendant of a declared phase.' },
        inferDeliveredOutOfScope: { type: 'boolean', description: 'Opt-in: flag a done WP whose latest verification is a violation (a read flag).' },
      },
      required: ['workspace', 'baselineCommit'],
    },
  },
  {
    name: 'track_cursor',
    description: 'M5 (canevas) — a cheap change cursor over the log tail, as JSON {head, count}. `head` = the log-tail event contentHash (null when empty); `count` = the event count. O(tail). The host\'s liveness primitive: poll this, re-read track_canevas / track_amendment_trace when it moves. Read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'track_canevas',
    description: 'M5 (canevas) — the materialized canevas for ONE workspace, as JSON {workspace, report, prov, affordances, dossier?}. report = the bucketed report + WP rollup forest (workspace-scoped); prov = per-aggregate latest-write provenance lineage {origin:human|machine, …}; affordances = per-aggregate legal next WorkEvent kinds (open-action affordances). With `decisionId`, also includes the full decision dossier. PURE (no clock, no socket — the host owns liveness).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'The workspace to materialize the canevas for.' },
        baselineCommit: { type: 'string', description: 'Commit AWAITED/acceptance are evaluated against.' },
        requireAccepted: { type: 'boolean', description: 'A done leaf counts as DONE only if acceptance=pass.' },
        decisionId: { type: 'string', description: 'Optional decision id — includes its full dossier (context/options/qa/outcome/artifacts).' },
      },
      required: ['workspace', 'baselineCommit'],
    },
  },
  {
    name: 'track_amendment_trace',
    description: 'M5 (canevas) — the human/machine diff for ONE aggregate, as JSON [{seq, at, by, kind, prov, origin, summary?, patchRef?, proposalRef?}]. An ordered (by seq), prov-tagged projection over the aggregate\'s spec.amended / dossier.revised / decision.artifact-added / decision.outcome events. `origin` derives PURELY from prov.proposed (true=machine, false=human). An AI proposal + a human acceptance both appear — the machine origin is never laundered. PURE replay.',
    inputSchema: {
      type: 'object',
      properties: { aggregateId: { type: 'string', description: 'The item/decision aggregate id to trace.' } },
      required: ['aggregateId'],
    },
  },
  {
    name: 'track_workspace_activity',
    description: 'Poll-able activity signal for ONE workspace (h2a conductor-launch gating), as JSON {workspace, pending, pendingItems[], stalled[], latestEventAt?}. PURE: the caller supplies `now` (and optional `idleMs`, default 24h) — track holds no clock. `pending` = TO-DO+AWAITED count and `pendingItems` lists the concrete open leaves; `stalled` = items/decisions durably stuck (awaited-open-blocker | pending-decision | in-progress-idle | todo-idle).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'The workspace to scope the signal to.' },
        baselineCommit: { type: 'string', description: 'Commit AWAITED is evaluated against.' },
        now: { type: 'string', description: 'Caller-supplied ISO-8601 "current" time (track holds no clock).' },
        idleMs: { type: 'number', description: 'Staleness window in ms (default 86400000 = 24h).' },
      },
      required: ['workspace', 'baselineCommit', 'now'],
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

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`tool argument "${key}" must be a number`)
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
    case 'track_status': {
      const level = optEnum(args, 'level', LEVELS)
      if (level === undefined) throw new Error('tool argument "level" must be one of: ' + LEVELS.join(', '))
      return statusText(
        reader,
        level,
        { baselineCommit: reqStr(args, 'baselineCommit'), requireAccepted: optBool(args, 'requireAccepted') ?? false },
        'json',
      )
    }
    case 'track_verification_runs': {
      const wpRef = optStr(args, 'wpRef')
      return JSON.stringify(reader.verificationRuns(wpRef), null, 2)
    }
    case 'track_scope_validate': {
      const content = optStr(args, 'content')
      const locator = optStr(args, 'locator')
      const claimedItemId = optStr(args, 'claimedItemId')
      const inferDeliveredOutOfScope = optBool(args, 'inferDeliveredOutOfScope')
      return JSON.stringify(
        reader.scopeValidate({
          workspace: reqStr(args, 'workspace'),
          baselineCommit: reqStr(args, 'baselineCommit'),
          ...(content !== undefined ? { content } : {}),
          ...(locator !== undefined ? { locator } : {}),
          ...(claimedItemId !== undefined ? { claimedItemId } : {}),
          ...(inferDeliveredOutOfScope !== undefined ? { inferDeliveredOutOfScope } : {}),
        }),
        null,
        2,
      )
    }
    case 'track_cursor':
      return JSON.stringify(reader.cursor(), null, 2)
    case 'track_canevas': {
      const requireAccepted = optBool(args, 'requireAccepted')
      const decisionId = optStr(args, 'decisionId')
      return JSON.stringify(
        reader.canevas(reqStr(args, 'workspace'), {
          baselineCommit: reqStr(args, 'baselineCommit'),
          ...(requireAccepted !== undefined ? { requireAccepted } : {}),
          ...(decisionId !== undefined ? { decisionId } : {}),
        }),
        null,
        2,
      )
    }
    case 'track_amendment_trace':
      return JSON.stringify(reader.amendmentTrace(reqStr(args, 'aggregateId')), null, 2)
    case 'track_validate':
      return JSON.stringify(reader.validate(), null, 2)
    case 'track_audit':
      return JSON.stringify(reader.audit(), null, 2)
    case 'track_external_deps':
      return JSON.stringify(reader.externalDependencies(), null, 2)
    case 'track_workspace_activity': {
      const idleMs = optNum(args, 'idleMs')
      return JSON.stringify(
        reader.workspaceActivity(reqStr(args, 'workspace'), {
          baselineCommit: reqStr(args, 'baselineCommit'),
          now: reqStr(args, 'now'),
          ...(idleMs !== undefined ? { idleMs } : {}),
        }),
        null,
        2,
      )
    }
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
