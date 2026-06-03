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
import { DomainError, type Gate, type ItemKind, type Realization, type SpecStatus } from '../model/item.js'
import { formatReport, formatRows, type Format } from '../report/format.js'
import { Track } from '../track.js'
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
  item ls [--workspace <w>] [--kind <k>] [--format json|text|md]
  decision new --kind <orientation|commitment> --title <t> --workspace <w> --targets <id,id> [--context <c>]
  decision outcome <decisionId> <go|no-go|deferred>
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
  query [--kind <k>] [--workspace <w>] [--bucket <B>] [--realization <r>] [--acceptance <a>] [--format json|text|md] [--commit <sha>]
  validate [--commit <sha>]
  branch import <BRANCH.md> [--commit <sha>]
`

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
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  } catch {
    return 'HEAD'
  }
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
function fmt(flags: Flags): Format {
  const f = opt(flags, 'format') ?? 'text'
  if (f !== 'json' && f !== 'text' && f !== 'md') throw new DomainError(`unknown --format ${f}`)
  return f
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

function cmdItem(args: string[], io: CliIO): number {
  const sub = args[0]
  const { positional, flags } = parseFlags(args.slice(1))
  const track = new Track(store(io.cwd))
  if (sub === 'new') {
    const id = track.createItem({
      kind: req(flags, 'kind') as ItemKind,
      title: req(flags, 'title'),
      workspace: opt(flags, 'workspace') ?? 'default',
      ...(opt(flags, 'body') !== undefined ? { body: req(flags, 'body') } : {}),
      ...(opt(flags, 'parent') !== undefined ? { parentId: req(flags, 'parent') } : {}),
    })
    io.out(`${id}\n`)
    return 0
  }
  if (sub === 'spec') {
    track.setSpec(positional[0]!, positional[1] as SpecStatus)
    io.out('ok\n')
    return 0
  }
  if (sub === 'realize') {
    track.setRealization(positional[0]!, positional[1] as Realization)
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
        ...(opt(flags, 'kind') !== undefined ? { kind: req(flags, 'kind') as Exclude<ItemKind, 'decision'> } : {}),
        ...(opt(flags, 'workspace') !== undefined ? { workspace: req(flags, 'workspace') } : {}),
      },
      { baselineCommit: opt(flags, 'commit') ?? gitHead(io.cwd) },
    )
    io.out(fmt(flags) === 'json' ? `${JSON.stringify(rows, null, 2)}\n` : formatRows(rows, fmt(flags)))
    return 0
  }
  io.err('usage: track item <new|spec|realize|show|ls>\n')
  return 2
}

function cmdDecision(args: string[], io: CliIO): number {
  const sub = args[0]
  const { positional, flags } = parseFlags(args.slice(1))
  const track = new Track(store(io.cwd))
  if (sub === 'new') {
    const id = track.createDecision({
      decisionKind: req(flags, 'kind') as DecisionKind,
      title: req(flags, 'title'),
      workspace: opt(flags, 'workspace') ?? 'default',
      targets: req(flags, 'targets').split(',').map((s) => s.trim()).filter(Boolean),
      dossier: { context: opt(flags, 'context') ?? '', options: [], qa: [] },
    })
    io.out(`${id}\n`)
    return 0
  }
  if (sub === 'outcome') {
    track.setOutcome(positional[0]!, positional[1] as Outcome)
    io.out('ok\n')
    return 0
  }
  if (sub === 'dossier') {
    track.reviseDossier(positional[0]!, { context: opt(flags, 'context') ?? '', options: [], qa: [] })
    io.out('ok\n')
    return 0
  }
  if (sub === 'disposition') {
    track.setDisposition(positional[0]!, positional[1] as Gate, positional[2] as 'required' | 'skipped' | 'not-applicable')
    io.out('ok\n')
    return 0
  }
  io.err('usage: track decision <new|outcome|dossier|disposition>\n')
  return 2
}

function cmdBlocker(args: string[], io: CliIO): number {
  const sub = args[0]
  const { positional, flags } = parseFlags(args.slice(1))
  const track = new Track(store(io.cwd))
  if (sub === 'raise') {
    const id = track.openBlocker({
      targetId: req(flags, 'target'),
      kind: req(flags, 'kind') as BlockerKind,
      ref: req(flags, 'ref'),
      reason: opt(flags, 'reason') ?? '',
      ...(opt(flags, 'rule') !== undefined ? { resolutionRule: req(flags, 'rule') as ResolutionRule } : {}),
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
  const track = new Track(store(io.cwd))
  if (sub === 'criterion') {
    io.out(`${track.addCriterion(positional[0]!, req(flags, 'statement'))}\n`)
    return 0
  }
  if (sub === 'link') {
    io.out(`${track.linkEvidence(positional[0]!, req(flags, 'kind') as EvidenceKind, req(flags, 'locator'))}\n`)
    return 0
  }
  if (sub === 'run') {
    const commit = opt(flags, 'commit') ?? gitHead(io.cwd)
    const env = opt(flags, 'env') ?? 'ci'
    const runner = opt(flags, 'runner') ?? 'cli'
    const from = opt(flags, 'from')
    if (from !== undefined) {
      const content = readFileSync(isAbsolute(from) ? from : join(io.cwd, from), 'utf8')
      const format = req(flags, 'format') === 'junit' ? 'junit' : 'json'
      const n = track.ingestRuns(content, format, { commit, env, runner })
      io.out(`ingested ${n} run(s)\n`)
      return 0
    }
    track.recordRun(positional[0]!, { commit, env, runner, result: req(flags, 'result') as RunResult })
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
  const track = new Track(store(io.cwd))
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
  const track = new Track(store(io.cwd))
  const report = track.report({
    baselineCommit: opt(flags, 'commit') ?? gitHead(io.cwd),
    requireAccepted: flags['require-accepted'] === true,
    decisions: flags['decisions'] === true,
  })
  io.out(formatReport(report, fmt(flags)))
  return 0
}

function cmdQuery(args: string[], io: CliIO): number {
  const { flags } = parseFlags(args)
  const track = new Track(store(io.cwd))
  const rows = track.query(
    {
      ...(opt(flags, 'kind') !== undefined ? { kind: req(flags, 'kind') as Exclude<ItemKind, 'decision'> } : {}),
      ...(opt(flags, 'workspace') !== undefined ? { workspace: req(flags, 'workspace') } : {}),
      ...(opt(flags, 'bucket') !== undefined ? { bucket: req(flags, 'bucket') as never } : {}),
      ...(opt(flags, 'realization') !== undefined ? { realization: req(flags, 'realization') as Realization } : {}),
      ...(opt(flags, 'acceptance') !== undefined ? { acceptance: req(flags, 'acceptance') as never } : {}),
    },
    { baselineCommit: opt(flags, 'commit') ?? gitHead(io.cwd) },
  )
  io.out(fmt(flags) === 'json' ? `${JSON.stringify(rows, null, 2)}\n` : formatRows(rows, fmt(flags)))
  return 0
}

function cmdValidate(args: string[], io: CliIO): number {
  const { flags } = parseFlags(args)
  const s = store(io.cwd)
  let events
  try {
    events = s.readAll()
  } catch (error) {
    io.out(`INVALID: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  const integrity = validate(events, readHead(eventsPath(io.cwd)))
  const track = new Track(s)
  const desync = desyncFindings(track.state(), io.cwd)
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
  const track = new Track(store(io.cwd))
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
