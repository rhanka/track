#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readHead } from '../events/head.js'
import { EventStore } from '../events/store.js'
import { validate } from '../events/validate.js'
import type { EvidenceKind, RunResult } from '../model/acceptance.js'
import type { BlockerKind, ResolutionRule } from '../model/blocker.js'
import type { DecisionKind, Outcome } from '../model/decision.js'
import { DomainError, type Disposition, type Gate, type ItemKind, type Realization, type SpecStatus } from '../model/item.js'
import type { Bucket } from '../report/buckets.js'
import { formatRows, type Format } from '../report/format.js'
import { Track } from '../track.js'
import type { ActorId, Provenance } from '../events/types.js'
import { TrackReader } from '../read/contract.js'
import { queryText, reportText } from '../read/commands.js'
import { desyncFindings } from './desync.js'

export interface CliIO {
  cwd: string
  out: (s: string) => void
  err: (s: string) => void
}

type Flags = Record<string, string | true>

const USAGE = `usage: track <command>
  init
  item new --kind <feature|bug|chore> --title <t> --workspace <w> [--body <b>] [--parent <id>]
  item spec <itemId> <to-specify|specified>
  item realize <itemId> <in-progress|done|cancelled>
  item show <itemId>
  item ls [--workspace <w>] [--kind <feature|bug|chore>] [--format json|text|md]
  decision new --kind <orientation|commitment> --title <t> --workspace <w> --targets <id,id> [--context <c>]
  decision outcome <decisionId> <go|no-go|deferred>
  decision dossier <decisionId> --context <c>
  decision disposition <itemId> <orientation|commitment> <required|skipped|not-applicable>
  blocker raise --target <id> --kind <decision|dependency> --ref <id> [--reason <r>] [--rule <linked-done|linked-accepted|manual>]
  blocker resolve <blockerId>
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
`

const ITEM_KINDS = ['feature', 'bug', 'chore'] as const
const SPEC_TARGETS = ['to-specify', 'specified'] as const
const REALIZE_TARGETS = ['in-progress', 'done', 'cancelled'] as const
const REALIZATIONS = ['to-do', 'in-progress', 'done', 'cancelled', 'rejected'] as const
const DECISION_KINDS = ['orientation', 'commitment'] as const
const OUTCOMES = ['go', 'no-go', 'deferred'] as const
const GATES = ['orientation', 'commitment'] as const
const DISPOSITIONS = ['required', 'skipped', 'not-applicable'] as const
const BLOCKER_KINDS = ['decision', 'dependency'] as const
// `linked-accepted` openness is DERIVED at report/query time vs `--commit` (v2.2a hybrid-A):
// the gate re-opens when the ref regresses. See src/report/blocker-status.ts.
const RESOLUTION_RULES = ['linked-done', 'linked-accepted', 'manual'] as const
const EVIDENCE_KINDS = ['unit', 'integration', 'e2e', 'manual'] as const
const RESULTS = ['pass', 'fail'] as const
const FROM_FORMATS = ['junit', 'json'] as const
const BUCKETS_ARG = ['AWAITED', 'DROPPED', 'DONE', 'TO-DO'] as const
// `n/a` is decision-only; `query` projects non-decision rows, so it would never match.
const ACCEPTANCES = ['fail', 'waived', 'unknown', 'stale', 'pass'] as const

function trackDir(cwd: string): string {
  return join(cwd, '.track')
}
function eventsPath(cwd: string): string {
  return join(trackDir(cwd), 'events.jsonl')
}
function store(cwd: string): EventStore {
  return new EventStore(eventsPath(cwd))
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
function writeTrack(io: CliIO): Track {
  return new Track(store(io.cwd), { by: cliActor(io.cwd), prov: CLI_PROV })
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

export function runCli(argv: string[], io: CliIO): number {
  const cmd = argv[0]
  const rest = argv.slice(1)
  try {
    switch (cmd) {
      case 'init':
        mkdirSync(trackDir(io.cwd), { recursive: true })
        io.out(`Initialized .track/ in ${io.cwd}\n`)
        return 0
      case 'item':
        return cmdItem(rest, io)
      case 'decision':
        return cmdDecision(rest, io)
      case 'blocker':
        return cmdBlocker(rest, io)
      case 'accept':
        return cmdAccept(rest, io)
      case 'priority':
        return cmdPriority(rest, io)
      case 'report':
        return cmdReport(rest, io)
      case 'query':
        return cmdQuery(rest, io)
      case 'validate':
        return cmdValidate(rest, io)
      case 'branch':
        return cmdBranch(rest, io)
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

function cmdItem(args: string[], io: CliIO): number {
  const sub = args[0]
  const { positional, flags } = parseFlags(args.slice(1))
  const track = writeTrack(io)
  if (sub === 'new') {
    const id = track.createItem({
      kind: oneOf(req(flags, 'kind'), ITEM_KINDS, '--kind') as ItemKind,
      title: req(flags, 'title'),
      workspace: req(flags, 'workspace'),
      ...(opt(flags, 'body') !== undefined ? { body: req(flags, 'body') } : {}),
      ...(opt(flags, 'parent') !== undefined ? { parentId: req(flags, 'parent') } : {}),
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

function cmdDecision(args: string[], io: CliIO): number {
  const sub = args[0]
  const { positional, flags } = parseFlags(args.slice(1))
  const track = writeTrack(io)
  if (sub === 'new') {
    const id = track.createDecision({
      decisionKind: oneOf(req(flags, 'kind'), DECISION_KINDS, '--kind') as DecisionKind,
      title: req(flags, 'title'),
      workspace: req(flags, 'workspace'),
      targets: req(flags, 'targets').split(',').map((s) => s.trim()).filter(Boolean),
      dossier: { context: opt(flags, 'context') ?? '', options: [], qa: [] },
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

function cmdBlocker(args: string[], io: CliIO): number {
  const sub = args[0]
  const { positional, flags } = parseFlags(args.slice(1))
  const track = writeTrack(io)
  if (sub === 'raise') {
    const id = track.openBlocker({
      targetId: req(flags, 'target'),
      kind: oneOf(req(flags, 'kind'), BLOCKER_KINDS, '--kind') as BlockerKind,
      ref: req(flags, 'ref'),
      reason: opt(flags, 'reason') ?? '',
      ...(opt(flags, 'rule') !== undefined
        ? { resolutionRule: oneOf(req(flags, 'rule'), RESOLUTION_RULES, '--rule') as ResolutionRule }
        : {}),
    })
    io.out(`${id}\n`)
    return 0
  }
  if (sub === 'resolve') {
    track.resolveBlocker(positional[0]!)
    io.out('ok\n')
    return 0
  }
  io.err('usage: track blocker <raise|resolve>\n')
  return 2
}

function cmdAccept(args: string[], io: CliIO): number {
  const sub = args[0]
  const { positional, flags } = parseFlags(args.slice(1))
  const track = writeTrack(io)
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
      io.out(`ingested ${track.ingestRuns(content, format, { commit, env, runner })} run(s)\n`)
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

function cmdPriority(args: string[], io: CliIO): number {
  const sub = args[0]
  const { positional, flags } = parseFlags(args.slice(1))
  const track = writeTrack(io)
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

function cmdReport(args: string[], io: CliIO): number {
  const { flags } = parseFlags(args)
  // Reads go through the shared TrackReader command layer (same path the MCP server uses).
  const reader = new TrackReader(eventsPath(io.cwd))
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

function cmdQuery(args: string[], io: CliIO): number {
  const { flags } = parseFlags(args)
  const reader = new TrackReader(eventsPath(io.cwd))
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

function cmdValidate(args: string[], io: CliIO): number {
  const { flags } = parseFlags(args)
  void flags
  const s = store(io.cwd)
  let events
  try {
    events = s.readAll()
  } catch (error) {
    io.out(`INVALID: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  const integrity = validate(events, readHead(eventsPath(io.cwd)))
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

function cmdBranch(args: string[], io: CliIO): number {
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
  const track = writeTrack(io)
  const result = track.importBranch(content, {
    locator: file,
    fileSlug: basename(file).replace(/\.md$/, ''),
    commit: opt(flags, 'commit') ?? gitHead(io.cwd),
  })
  io.out(`Imported ${result.branchSlug}: ${result.created} created, ${result.updated} updated\n`)
  return 0
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(
    runCli(process.argv.slice(2), {
      cwd: process.cwd(),
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    }),
  )
}
