import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { readHead } from '../events/head.js'
import { EventStore } from '../events/store.js'
import { validate } from '../events/validate.js'
import { initTrackDir, resolveTrackDir } from './resolve.js'
import type { EvidenceKind, RunResult } from '../model/acceptance.js'
import type { BlockerKind, BlockerScope, ResolutionRule } from '../model/blocker.js'
import type { DecisionKind, Outcome } from '../model/decision.js'
import { DomainError, type Disposition, type Gate, type ItemKind, type Realization, type SpecStatus } from '../model/item.js'
import type { Bucket } from '../report/buckets.js'
import { formatRows, type Format } from '../report/format.js'
import { Track } from '../track.js'
import type { ActorId, Provenance } from '../events/types.js'
import {
  BLOCKER_KINDS,
  BLOCKER_SCOPES,
  DECISION_KINDS,
  DISPOSITIONS,
  EVIDENCE_KINDS,
  GATES,
  ITEM_KINDS,
  OUTCOMES,
  REALIZE_TARGETS,
  RESOLUTION_RULES,
  RESULTS,
  SPEC_TARGETS,
  type WorkEvent,
} from '../ingest/contract.js'
import { ingest, type IngestContext } from '../ingest/ingest.js'
import { TrackReader } from '../read/contract.js'
import { queryText, reportText } from '../read/commands.js'
import { VERSION } from '../version.js'
import { desyncFindings } from './desync.js'

export interface CliIO {
  cwd: string
  out: (s: string) => void
  err: (s: string) => void
}

/**
 * A resolved CLI context: the caller's `io` plus the single `.track/events.jsonl` path resolved ONCE
 * (nearest-ancestor `.track`, or an explicit `--track-dir`/`TRACK_DIR`) — so every handler reads and
 * writes the SAME store and a subdir write can never land in a stray sidecar. `io.cwd` is still used
 * for git/actor and relative file resolution; `eventsPath` is the source of truth for the log.
 */
interface Ctx {
  io: CliIO
  eventsPath: string
}

type Flags = Record<string, string | true>

const USAGE = `usage: track <command>
  --version | -v
  init
  item new --kind <feature|bug|chore> --title <t> --workspace <w> [--body <b>] [--parent <id>] [--accountable <a>] [--responsible <a,a>] [--engagement-ref <e>]
  item spec <itemId> <to-specify|specified>
  item realize <itemId> <in-progress|done|cancelled>
  item show <itemId>
  item ls [--workspace <w>] [--kind <feature|bug|chore>] [--format json|text|md]
  decision new --kind <orientation|commitment> --title <t> --workspace <w> --targets <id,id> [--context <c>] [--accountable <a>] [--engagement-ref <e>]
  decision outcome <decisionId> <go|no-go|deferred>
  decision dossier <decisionId> --context <c>
  decision disposition <itemId> <orientation|commitment> <required|skipped|not-applicable>
  blocker raise --target <id> --kind <decision|dependency> [--ref <id>] [--reason <r>] [--rule <linked-done|linked-accepted|manual>] [--scope <intra|extra>] [--engagement-ref <e>]
  blocker resolve <blockerId>
  blocker resolve-external --engagement-ref <e>
  accept criterion <itemId> --statement <s>
  accept link <criterionId> --kind <unit|integration|e2e|manual> --locator <l>
  accept run <evidenceId> --result <pass|fail> [--commit <c>] [--env <e>] [--runner <r>]
  accept run --from <report> --format <junit|json> [--commit <c>] [--env <e>] [--runner <r>]
  accept waive <criterionId> --reason <r>
  priority assess <itemId> --ubv <n> --tc <n> --rr <n> --js <n>
  report [--decisions] [--require-accepted] [--format json|text|md] [--commit <sha>]
  query [--kind <k>] [--workspace <w>] [--bucket <AWAITED|DROPPED|DONE|TO-DO>] [--realization <r>] [--acceptance <a>] [--format json|text|md] [--commit <sha>]
  validate [--commit <sha>]
  branch import <BRANCH.md> [--commit <sha>]
  ingest <file.jsonl> --workspace <w>
`

// Write enums (ITEM_KINDS, SPEC_TARGETS, REALIZE_TARGETS, DECISION_KINDS, OUTCOMES, GATES, DISPOSITIONS,
// BLOCKER_KINDS, RESOLUTION_RULES, EVIDENCE_KINDS, RESULTS) are sourced from the ingest contract — the
// SINGLE source, so the CLI's `oneOf` checks and the WorkEvent mapper cannot diverge on accepted values.
// (`linked-accepted` openness is DERIVED at report/query time vs `--commit`, v2.2a hybrid-A; see
// src/report/blocker-status.ts.) Only CLI/read-projection enums stay local:
const REALIZATIONS = ['to-do', 'in-progress', 'done', 'cancelled', 'rejected'] as const
const FROM_FORMATS = ['junit', 'json'] as const
const BUCKETS_ARG = ['AWAITED', 'DROPPED', 'DONE', 'TO-DO'] as const
// `n/a` is decision-only; `query` projects non-decision rows, so it would never match.
const ACCEPTANCES = ['fail', 'waived', 'unknown', 'stale', 'pass'] as const

function eventsPathOf(trackDir: string): string {
  return join(trackDir, 'events.jsonl')
}
function store(ctx: Ctx): EventStore {
  return new EventStore(ctx.eventsPath)
}
function gitHead(cwd: string): string {
  try {
    // stdio: silence git's own stderr (off-repo, rev-parse fails — we fall back to 'HEAD').
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'HEAD'
  }
}

// D3: CLI writes are attributed to the LOCAL USER (never the reserved `'system'`), with `cli`
// provenance — so the immutable log honestly distinguishes a human-CLI write from an agent one.
const CLI_PROV: Provenance = { transport: 'cli', proposed: false, auth: 'local-user' }

function cliActor(cwd: string): ActorId {
  try {
    const email = execFileSync('git', ['config', 'user.email'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (email) return `human:${email}`
  } catch {
    /* not a repo / git absent — fall through */
  }
  const user = process.env['USER'] ?? process.env['USERNAME']
  return user ? `human:${user}` : 'cli:unknown'
}

/** A writer Track for CLI commands — attributed to the local user with `cli` provenance (D3). */
function writeTrack(ctx: Ctx): Track {
  return new Track(store(ctx), { by: cliActor(ctx.io.cwd), prov: CLI_PROV })
}

function parseFlags(args: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = []
  const flags: Flags = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

function req(flags: Flags, key: string): string {
  const v = flags[key]
  if (typeof v !== 'string') throw new DomainError(`missing required --${key}`)
  return v
}
function opt(flags: Flags, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}
function num(flags: Flags, key: string): number {
  const n = Number(req(flags, key))
  if (Number.isNaN(n)) throw new DomainError(`--${key} must be a number`)
  return n
}
/** Validate a positional/flag against an allowed enum (CLI-boundary input validation). */
function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T {
  if (value === undefined || !(allowed as readonly string[]).includes(value)) {
    throw new DomainError(`${name} must be one of: ${allowed.join('|')} (got ${value === undefined ? '<none>' : `"${value}"`})`)
  }
  return value as T
}
function fmt(flags: Flags): Format {
  return oneOf(opt(flags, 'format') ?? 'text', ['json', 'text', 'md'], '--format')
}

/**
 * Pull a global `--track-dir <path>` out of argv BEFORE per-command parsing, so it works regardless
 * of where the user places it. Returns the value (if any) and the argv with that flag removed.
 */
function extractTrackDirFlag(argv: string[]): { trackDirFlag?: string; rest: string[] } {
  const rest: string[] = []
  let trackDirFlag: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--track-dir') {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        trackDirFlag = next
        i++
        continue
      }
    }
    rest.push(a)
  }
  return trackDirFlag !== undefined ? { trackDirFlag, rest } : { rest }
}

export function runCli(rawArgv: string[], io: CliIO): number {
  const { trackDirFlag, rest: argv } = extractTrackDirFlag(rawArgv)
  const cmd = argv[0]
  const rest = argv.slice(1)
  const trackDirEnv = process.env['TRACK_DIR']
  const resolveOpts = {
    cwd: io.cwd,
    ...(trackDirFlag !== undefined ? { flag: trackDirFlag } : {}),
    ...(trackDirEnv !== undefined ? { env: trackDirEnv } : {}),
  }
  try {
    switch (cmd) {
      case '--version':
      case '-v':
      case 'version':
        io.out(`${VERSION}\n`)
        return 0
      case 'init': {
        // The ONLY command that creates a `.track` — at cwd/.track (or an explicit override).
        const dir = initTrackDir(resolveOpts)
        mkdirSync(dir, { recursive: true })
        io.out(`Initialized .track/ in ${dirname(dir)}\n`)
        return 0
      }
      // Every other command resolves the nearest-ancestor `.track` and FAILS LOUD if none exists. The
      // USAGE/rc=2 branch for an UNKNOWN command is reached BEFORE resolution (a typo must not be masked
      // by a "no .track" error), so `resolveTrackDir` runs only for a recognized command.
      case 'item':
      case 'decision':
      case 'blocker':
      case 'accept':
      case 'priority':
      case 'report':
      case 'query':
      case 'validate':
      case 'branch':
      case 'ingest': {
        const ctx: Ctx = { io, eventsPath: eventsPathOf(resolveTrackDir(resolveOpts)) }
        switch (cmd) {
          case 'item':
            return cmdItem(rest, ctx)
          case 'decision':
            return cmdDecision(rest, ctx)
          case 'blocker':
            return cmdBlocker(rest, ctx)
          case 'accept':
            return cmdAccept(rest, ctx)
          case 'priority':
            return cmdPriority(rest, ctx)
          case 'report':
            return cmdReport(rest, ctx)
          case 'query':
            return cmdQuery(rest, ctx)
          case 'validate':
            return cmdValidate(rest, ctx)
          case 'branch':
            return cmdBranch(rest, ctx)
          case 'ingest':
            return cmdIngest(rest, ctx)
        }
        // unreachable — the outer case list and this inner switch are identical
        io.err(USAGE)
        return 2
      }
      default:
        io.err(USAGE)
        return 2
    }
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

function rowsOut(rows: unknown[], format: Format, io: CliIO): void {
  io.out(format === 'json' ? `${JSON.stringify(rows, null, 2)}\n` : formatRows(rows as never, format))
}

function cmdItem(args: string[], ctx: Ctx): number {
  const { io } = ctx
  const sub = args[0]
  const { positional, flags } = parseFlags(args.slice(1))
  const track = writeTrack(ctx)
  if (sub === 'new') {
    const id = track.createItem({
      kind: oneOf(req(flags, 'kind'), ITEM_KINDS, '--kind') as ItemKind,
      title: req(flags, 'title'),
      workspace: req(flags, 'workspace'),
      ...(opt(flags, 'body') !== undefined ? { body: req(flags, 'body') } : {}),
      ...(opt(flags, 'parent') !== undefined ? { parentId: req(flags, 'parent') } : {}),
      ...(opt(flags, 'accountable') !== undefined ? { accountable: req(flags, 'accountable') } : {}),
      ...(opt(flags, 'responsible') !== undefined
        ? { responsible: req(flags, 'responsible').split(',').map((s) => s.trim()).filter(Boolean) }
        : {}),
      ...(opt(flags, 'engagement-ref') !== undefined ? { engagementRef: req(flags, 'engagement-ref') } : {}),
    })
    io.out(`${id}\n`)
    return 0
  }
  if (sub === 'spec') {
    track.setSpec(positional[0]!, oneOf(positional[1], SPEC_TARGETS, 'spec') as SpecStatus)
    io.out('ok\n')
    return 0
  }
  if (sub === 'realize') {
    track.setRealization(positional[0]!, oneOf(positional[1], REALIZE_TARGETS, 'realize') as Realization)
    io.out('ok\n')
    return 0
  }
  if (sub === 'show') {
    io.out(`${JSON.stringify(track.state().items.get(positional[0]!) ?? null, null, 2)}\n`)
    return 0
  }
  if (sub === 'ls') {
    const rows = track.query(
      {
        ...(opt(flags, 'kind') !== undefined ? { kind: oneOf(req(flags, 'kind'), ITEM_KINDS, '--kind') } : {}),
        ...(opt(flags, 'workspace') !== undefined ? { workspace: req(flags, 'workspace') } : {}),
      },
      { baselineCommit: opt(flags, 'commit') ?? gitHead(io.cwd) },
    )
    rowsOut(rows, fmt(flags), io)
    return 0
  }
  io.err('usage: track item <new|spec|realize|show|ls>\n')
  return 2
}

function cmdDecision(args: string[], ctx: Ctx): number {
  const { io } = ctx
  const sub = args[0]
  const { positional, flags } = parseFlags(args.slice(1))
  const track = writeTrack(ctx)
  if (sub === 'new') {
    const id = track.createDecision({
      decisionKind: oneOf(req(flags, 'kind'), DECISION_KINDS, '--kind') as DecisionKind,
      title: req(flags, 'title'),
      workspace: req(flags, 'workspace'),
      targets: req(flags, 'targets').split(',').map((s) => s.trim()).filter(Boolean),
      dossier: { context: opt(flags, 'context') ?? '', options: [], qa: [] },
      ...(opt(flags, 'accountable') !== undefined ? { accountable: req(flags, 'accountable') } : {}),
      ...(opt(flags, 'engagement-ref') !== undefined ? { engagementRef: req(flags, 'engagement-ref') } : {}),
    })
    io.out(`${id}\n`)
    return 0
  }
  if (sub === 'outcome') {
    track.setOutcome(positional[0]!, oneOf(positional[1], OUTCOMES, 'outcome') as Outcome)
    io.out('ok\n')
    return 0
  }
  if (sub === 'dossier') {
    // merge: a context-only edit must not erase existing options/qa/recommendation
    const current = track.state().decisions.get(positional[0]!)?.dossier
    if (current === undefined) throw new DomainError(`unknown decision ${positional[0]!}`)
    track.reviseDossier(positional[0]!, { ...current, context: opt(flags, 'context') ?? current.context })
    io.out('ok\n')
    return 0
  }
  if (sub === 'disposition') {
    track.setDisposition(
      positional[0]!,
      oneOf(positional[1], GATES, 'gate') as Gate,
      oneOf(positional[2], DISPOSITIONS, 'disposition') as Exclude<Disposition, 'completed'>,
    )
    io.out('ok\n')
    return 0
  }
  io.err('usage: track decision <new|outcome|dossier|disposition>\n')
  return 2
}

function cmdBlocker(args: string[], ctx: Ctx): number {
  const { io } = ctx
  const sub = args[0]
  const { positional, flags } = parseFlags(args.slice(1))
  const track = writeTrack(ctx)
  if (sub === 'raise') {
    const id = track.openBlocker({
      targetId: req(flags, 'target'),
      kind: oneOf(req(flags, 'kind'), BLOCKER_KINDS, '--kind') as BlockerKind,
      ...(opt(flags, 'ref') !== undefined ? { ref: req(flags, 'ref') } : {}),
      reason: opt(flags, 'reason') ?? '',
      ...(opt(flags, 'rule') !== undefined
        ? { resolutionRule: oneOf(req(flags, 'rule'), RESOLUTION_RULES, '--rule') as ResolutionRule }
        : {}),
      ...(opt(flags, 'scope') !== undefined
        ? { scope: oneOf(req(flags, 'scope'), BLOCKER_SCOPES, '--scope') as BlockerScope }
        : {}),
      ...(opt(flags, 'engagement-ref') !== undefined ? { engagementRef: req(flags, 'engagement-ref') } : {}),
    })
    io.out(`${id}\n`)
    return 0
  }
  if (sub === 'resolve') {
    track.resolveBlocker(positional[0]!)
    io.out('ok\n')
    return 0
  }
  if (sub === 'resolve-external') {
    // A local CLI human is the trust root — explicitly unscoped (resolves the engagement's deps everywhere).
    // WHITELISTED no-op: 0 matches is a genuine no-op (nothing to resolve / idempotent retry) and is the
    // ONLY case where this command persists nothing — say so explicitly rather than implying a write.
    const ids = track.resolveExternalDependency(req(flags, 'engagement-ref'), 'all-workspaces')
    io.out(
      ids.length === 0
        ? `no-op: 0 external dependency blocker(s) matched\n`
        : `resolved ${ids.length} external dependency blocker(s)\n`,
    )
    return 0
  }
  io.err('usage: track blocker <raise|resolve|resolve-external>\n')
  return 2
}

function cmdAccept(args: string[], ctx: Ctx): number {
  const { io } = ctx
  const sub = args[0]
  const { positional, flags } = parseFlags(args.slice(1))
  const track = writeTrack(ctx)
  if (sub === 'criterion') {
    io.out(`${track.addCriterion(positional[0]!, req(flags, 'statement'))}\n`)
    return 0
  }
  if (sub === 'link') {
    io.out(
      `${track.linkEvidence(positional[0]!, oneOf(req(flags, 'kind'), EVIDENCE_KINDS, '--kind') as EvidenceKind, req(flags, 'locator'))}\n`,
    )
    return 0
  }
  if (sub === 'run') {
    const commit = opt(flags, 'commit') ?? gitHead(io.cwd)
    const env = opt(flags, 'env') ?? 'ci'
    const runner = opt(flags, 'runner') ?? 'cli'
    const from = opt(flags, 'from')
    if (from !== undefined) {
      const content = readFileSync(isAbsolute(from) ? from : join(io.cwd, from), 'utf8')
      const format = oneOf(req(flags, 'format'), FROM_FORMATS, '--format')
      // WHITELISTED no-op: an idempotent re-ingest (every asserted result already latest in the log)
      // records nothing — say "no-op" rather than "ingested 0 run(s)", which reads like a silent write.
      const n = track.ingestRuns(content, format, { commit, env, runner })
      io.out(n === 0 ? `no-op: 0 run(s) ingested (already current)\n` : `ingested ${n} run(s)\n`)
      return 0
    }
    track.recordRun(positional[0]!, {
      commit,
      env,
      runner,
      result: oneOf(req(flags, 'result'), RESULTS, '--result') as RunResult,
    })
    io.out('ok\n')
    return 0
  }
  if (sub === 'waive') {
    track.waive(positional[0]!, req(flags, 'reason'))
    io.out('ok\n')
    return 0
  }
  io.err('usage: track accept <criterion|link|run|waive>\n')
  return 2
}

function cmdPriority(args: string[], ctx: Ctx): number {
  const { io } = ctx
  const sub = args[0]
  const { positional, flags } = parseFlags(args.slice(1))
  const track = writeTrack(ctx)
  if (sub === 'assess') {
    const a = track.assessPriority(positional[0]!, {
      userBusinessValue: num(flags, 'ubv'),
      timeCriticality: num(flags, 'tc'),
      riskReductionOpportunityEnablement: num(flags, 'rr'),
      jobSize: num(flags, 'js'),
    })
    io.out(`wsjf score ${a.score}\n`)
    return 0
  }
  io.err('usage: track priority assess <itemId> --ubv --tc --rr --js\n')
  return 2
}

function cmdReport(args: string[], ctx: Ctx): number {
  const { io } = ctx
  const { flags } = parseFlags(args)
  // Reads go through the shared TrackReader command layer (same path the MCP server uses).
  const reader = new TrackReader(ctx.eventsPath)
  io.out(
    reportText(
      reader,
      {
        baselineCommit: opt(flags, 'commit') ?? gitHead(io.cwd),
        requireAccepted: flags['require-accepted'] === true,
        decisions: flags['decisions'] === true,
      },
      fmt(flags),
    ),
  )
  return 0
}

function cmdQuery(args: string[], ctx: Ctx): number {
  const { io } = ctx
  const { flags } = parseFlags(args)
  const reader = new TrackReader(ctx.eventsPath)
  io.out(
    queryText(
      reader,
      {
      ...(opt(flags, 'kind') !== undefined ? { kind: oneOf(req(flags, 'kind'), ITEM_KINDS, '--kind') } : {}),
      ...(opt(flags, 'workspace') !== undefined ? { workspace: req(flags, 'workspace') } : {}),
      ...(opt(flags, 'bucket') !== undefined ? { bucket: oneOf(req(flags, 'bucket'), BUCKETS_ARG, '--bucket') as Bucket } : {}),
      ...(opt(flags, 'realization') !== undefined
        ? { realization: oneOf(req(flags, 'realization'), REALIZATIONS, '--realization') as Realization }
        : {}),
      ...(opt(flags, 'acceptance') !== undefined
        ? { acceptance: oneOf(req(flags, 'acceptance'), ACCEPTANCES, '--acceptance') as never }
        : {}),
      },
      { baselineCommit: opt(flags, 'commit') ?? gitHead(io.cwd) },
      fmt(flags),
    ),
  )
  return 0
}

function cmdValidate(args: string[], ctx: Ctx): number {
  const { io } = ctx
  const { flags } = parseFlags(args)
  void flags
  const s = store(ctx)
  let events
  try {
    events = s.readAll()
  } catch (error) {
    io.out(`INVALID: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  const integrity = validate(events, readHead(ctx.eventsPath))
  const desync = desyncFindings(new Track(s).state(), io.cwd)
  const findings = [...integrity.findings.map((f) => ({ ...f })), ...desync]
  if (findings.length === 0) {
    io.out(`OK: ${events.length} events, integrity + desync clean\n`)
    return 0
  }
  io.out(`INVALID: ${integrity.findings.length} integrity + ${desync.length} desync finding(s)\n`)
  io.out(`${JSON.stringify(findings, null, 2)}\n`)
  return 1
}

function cmdBranch(args: string[], ctx: Ctx): number {
  const { io } = ctx
  if (args[0] !== 'import') {
    io.err('usage: track branch import <BRANCH.md> [--commit <sha>]\n')
    return 2
  }
  const { positional, flags } = parseFlags(args.slice(1))
  const file = positional[0]
  if (file === undefined) {
    io.err('usage: track branch import <BRANCH.md> [--commit <sha>]\n')
    return 2
  }
  const content = readFileSync(isAbsolute(file) ? file : join(io.cwd, file), 'utf8')
  const track = writeTrack(ctx)
  const result = track.importBranch(content, {
    locator: file,
    fileSlug: basename(file).replace(/\.md$/, ''),
    commit: opt(flags, 'commit') ?? gitHead(io.cwd),
  })
  io.out(`Imported ${result.branchSlug}: ${result.created} created, ${result.updated} updated\n`)
  return 0
}

/**
 * `track ingest <file.jsonl> --workspace <w>` — apply a neutral WorkEvent stream (M2b channel ①). A
 * local-user channel pinned to one workspace; provenance is `transport:'import'` to keep batch ingest
 * distinguishable from interactive CLI writes in the audit log. Same shape as `branch import` /
 * `accept run --from`: a local-file adapter, not a network transport.
 */
function cmdIngest(args: string[], cliCtx: Ctx): number {
  const { io } = cliCtx
  const { positional, flags } = parseFlags(args)
  const file = positional[0]
  if (file === undefined) {
    io.err('usage: track ingest <file.jsonl> --workspace <w>\n')
    return 2
  }
  const workspace = req(flags, 'workspace')
  const raw = readFileSync(isAbsolute(file) ? file : join(io.cwd, file), 'utf8')
  const events: WorkEvent[] = []
  raw.split('\n').forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    try {
      events.push(JSON.parse(trimmed) as WorkEvent)
    } catch {
      throw new DomainError(`ingest: malformed JSON on line ${i + 1}`)
    }
  })
  const ctx: IngestContext = {
    by: cliActor(io.cwd),
    workspace,
    prov: { transport: 'import', proposed: false, auth: 'local-user' },
  }
  const s = store(cliCtx)
  // `ingest().count` is the INPUT length, not the persisted count (a dedup'd WorkEvent is skipped, not
  // appended). To classify a genuine no-op we compare the persisted log length before/after: if nothing
  // new landed, EVERY event was a dedup'd retry — say "no-op" explicitly (WHITELISTED), never imply a write.
  const before = s.readAll().length
  const result = ingest(events, ctx, s)
  const after = s.readAll().length
  if (after === before) {
    io.out('no-op: 0 event(s) ingested (already applied)\n')
    return 0
  }
  for (const id of result.ids) io.out(`${id ?? '-'}\n`)
  return 0
}
