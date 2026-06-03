#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EventStore } from '../events/store.js'
import { formatReport, type Format } from '../report/format.js'
import { Track } from '../track.js'

export interface CliIO {
  cwd: string
  out: (s: string) => void
  err: (s: string) => void
}

const USAGE =
  'usage: track <init | branch import <BRANCH.md> [--commit <sha>] | ' +
  'report [--decisions] [--require-accepted] [--format json|text|md] [--commit <sha>]>\n'

function trackDir(cwd: string): string {
  return join(cwd, '.track')
}

function store(cwd: string): EventStore {
  return new EventStore(join(trackDir(cwd), 'events.jsonl'))
}

function gitHead(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  } catch {
    return 'HEAD'
  }
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
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

export function runCli(argv: string[], io: CliIO): number {
  const cmd = argv[0]
  const rest = argv.slice(1)

  if (cmd === 'init') {
    mkdirSync(trackDir(io.cwd), { recursive: true })
    io.out(`Initialized .track/ in ${io.cwd}\n`)
    return 0
  }

  if (cmd === 'branch' && rest[0] === 'import') {
    const { positional, flags } = parseFlags(rest.slice(1))
    const file = positional[0]
    if (file === undefined) {
      io.err('usage: track branch import <BRANCH.md> [--commit <sha>]\n')
      return 2
    }
    const content = readFileSync(file, 'utf8')
    const commit = typeof flags['commit'] === 'string' ? flags['commit'] : gitHead(io.cwd)
    const track = new Track(store(io.cwd))
    const result = track.importBranch(content, {
      locator: file,
      fileSlug: basename(file).replace(/\.md$/, ''),
      commit,
    })
    io.out(`Imported ${result.branchSlug}: ${result.created} created, ${result.updated} updated\n`)
    return 0
  }

  if (cmd === 'report') {
    const { flags } = parseFlags(rest)
    const format = (typeof flags['format'] === 'string' ? flags['format'] : 'text') as Format
    const commit = typeof flags['commit'] === 'string' ? flags['commit'] : gitHead(io.cwd)
    const track = new Track(store(io.cwd))
    const report = track.report({
      baselineCommit: commit,
      requireAccepted: flags['require-accepted'] === true,
      decisions: flags['decisions'] === true,
    })
    io.out(formatReport(report, format))
    return 0
  }

  io.err(USAGE)
  return 2
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
