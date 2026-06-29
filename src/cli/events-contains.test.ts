import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import type { CommandEvent } from '../events/types.js'
import { runCli, type CliIO } from './index.js'

// B0b — `track events-contains --base <log> --candidate <log>` is a PURE, git-free, store-free
// containment primitive: it reads two EXPLICIT `.track` logs, extracts each event's stable ULID `id`,
// and reports the ids present in `--base` but ABSENT from `--candidate`. rc=0 ⇔ candidate ⊇ base
// (no loss); rc=1 ⇔ at least one base id is missing (loss detected); rc=2 ⇔ cannot evaluate (bad
// flags / missing file / unreadable log) — so a CI gate can tell a real LOSS (rc=1) from a SETUP
// error (rc=2). It deliberately does NOT `validate`: a union-merged candidate (broken positional
// chain) still enumerates every event, so containment stays computable over a merged tail.

let dir: string
let out: string[]
let err: string[]
let io: CliIO
let counter: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-contains-'))
  out = []
  err = []
  io = { cwd: dir, out: (s) => out.push(s), err: (s) => err.push(s) }
  counter = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function evt(over: Partial<CommandEvent> = {}): CommandEvent {
  counter += 1
  return {
    id: `evt-${String(counter).padStart(4, '0')}`,
    type: 'item.created',
    aggregate: 'item',
    aggregateId: 'item-A',
    at: `2026-06-03T10:00:${String(counter).padStart(2, '0')}.000Z`,
    by: 'tester',
    payload: { kind: 'feature', title: `t${counter}`, workspace: 'w' },
    ...over,
  }
}

function logPath(label: string): string {
  const p = join(dir, label, '.track', 'events.jsonl')
  mkdirSync(dirname(p), { recursive: true })
  return p
}

describe('track events-contains', () => {
  it('rc=0 when candidate ⊇ base (containment holds)', () => {
    const basePath = logPath('base')
    const base = new EventStore(basePath)
    base.appendCommand([evt({ aggregateId: 'item-X' })])
    base.appendCommand([evt({ aggregateId: 'item-X', type: 'realization.transition', payload: { to: 'done' } })])

    // Candidate = a strict superset: base copied + an extra disjoint event.
    const candPath = logPath('cand')
    copyFileSync(basePath, candPath)
    new EventStore(candPath).appendCommand([evt({ aggregateId: 'item-Y' })])

    const rc = runCli(['events-contains', '--base', basePath, '--candidate', candPath], io)
    expect(rc).toBe(0)
    expect(out.join('')).toMatch(/^OK: candidate contains all 2 base event id\(s\)/)
  })

  it('rc=1 + lists the missing id when a base event is absent from candidate', () => {
    const basePath = logPath('base')
    const base = new EventStore(basePath)
    base.appendCommand([evt({ id: 'evt-keep-1', aggregateId: 'item-X' })])
    base.appendCommand([evt({ id: 'evt-keep-2', aggregateId: 'item-X', type: 'realization.transition', payload: { to: 'in-progress' } })])
    base.appendCommand([evt({ id: 'evt-lost-3', aggregateId: 'item-X', type: 'realization.transition', payload: { to: 'done' } })])

    // Candidate dropped the last base event (the graphify-style loss: a committed event vanished).
    const candPath = logPath('cand')
    const lines = readFileSync(basePath, 'utf8').split('\n').filter((l) => l.trim().length > 0)
    writeFileSync(candPath, lines.slice(0, 2).join('\n') + '\n', 'utf8')

    const rc = runCli(['events-contains', '--base', basePath, '--candidate', candPath], io)
    expect(rc).toBe(1)
    const text = out.join('')
    expect(text).toMatch(/^LOSS: 1 of 3 base event id\(s\) missing from candidate/)
    expect(text).toContain('evt-lost-3')
    expect(text).not.toContain('evt-keep-1')
  })

  it('--format json reports a structured containment result', () => {
    const basePath = logPath('base')
    new EventStore(basePath).appendCommand([evt({ id: 'evt-only', aggregateId: 'item-X' })])
    const candPath = logPath('cand')
    writeFileSync(candPath, '', 'utf8') // empty candidate ⇒ the base id is missing

    const rc = runCli(['events-contains', '--base', basePath, '--candidate', candPath, '--format', 'json'], io)
    expect(rc).toBe(1)
    const parsed = JSON.parse(out.join('')) as {
      contained: boolean
      baseCount: number
      candidateCount: number
      missingIds: string[]
    }
    expect(parsed.contained).toBe(false)
    expect(parsed.baseCount).toBe(1)
    expect(parsed.candidateCount).toBe(0)
    expect(parsed.missingIds).toEqual(['evt-only'])
  })

  it('rc=2 on a missing required flag', () => {
    const basePath = logPath('base')
    new EventStore(basePath).appendCommand([evt()])
    const rc = runCli(['events-contains', '--base', basePath], io)
    expect(rc).toBe(2)
    expect(err.join('')).toMatch(/usage: track events-contains/)
  })

  it('rc=2 when a log file does not exist (cannot evaluate, never a false PASS)', () => {
    const basePath = logPath('base')
    new EventStore(basePath).appendCommand([evt()])
    const rc = runCli(['events-contains', '--base', basePath, '--candidate', join(dir, 'nope.jsonl')], io)
    expect(rc).toBe(2)
    expect(err.join('')).toMatch(/not found/)
  })
})
