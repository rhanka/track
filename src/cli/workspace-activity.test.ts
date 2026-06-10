// `track workspace-activity --workspace <id> [--baseline-commit <sha>] [--now <iso>] [--idle-ms <ms>]
// [--format json|text]` — a READ verb that wraps the shipped, clockless `TrackReader.workspaceActivity`.
// h2a (itself an MCP stdio server, so it can't be a client of track's MCP) shells out to this verb to
// poll one workspace. It performs NO append (side-effect-free), parity with the library method, and
// serve-empty when no `.track` resolves. This task ONLY wraps the read — no new staleness logic.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
import { TrackReader } from '../read/contract.js'
import { Track } from '../track.js'
import { runCli, type CliIO } from './index.js'

let root: string
let trackDir: string
let eventsPath: string
let out: string[]
let err: string[]

function io(cwd: string): CliIO {
  return { cwd, out: (s) => out.push(s), err: (s) => err.push(s) }
}

const OLD = '2020-01-01T00:00:00.000Z' // well before any plausible `--now`
const NOW = '2020-06-01T00:00:00.000Z' // ~5 months later ⇒ a 24h-idle in-progress item is stalled

/** Seed a `.track` log via the Track facade with a FIXED old clock, so timing-based staleness fires. */
function seed(): { inProgressId: string } {
  const track = new Track(new EventStore(eventsPath), { by: 'human:t@t', now: () => OLD })
  const inProgressId = track.createItem({ kind: 'feature', title: 'stuck feature', workspace: 'ws-1' })
  track.setRealization(inProgressId, 'in-progress')
  // a second item in a DIFFERENT workspace — must not leak into ws-1's activity
  track.createItem({ kind: 'chore', title: 'elsewhere', workspace: 'ws-2' })
  return { inProgressId }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'track-wsact-'))
  trackDir = join(root, '.track')
  mkdirSync(trackDir, { recursive: true })
  eventsPath = join(trackDir, 'events.jsonl')
  out = []
  err = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('track workspace-activity', () => {
  it('parity: the verb returns the same {pending,stalled,latestEventAt} as the library method', () => {
    seed()
    const code = runCli(
      ['workspace-activity', '--workspace', 'ws-1', '--baseline-commit', 'c1', '--now', NOW, '--format', 'json'],
      io(root),
    )
    expect(code).toBe(0)
    const printed = JSON.parse(out.join(''))
    const expected = new TrackReader(eventsPath).workspaceActivity('ws-1', { baselineCommit: 'c1', now: NOW })
    expect(printed).toEqual(expected)
  })

  it('--workspace missing → rc=2 + usage', () => {
    seed()
    const code = runCli(['workspace-activity', '--baseline-commit', 'c1', '--now', NOW], io(root))
    expect(code).toBe(2)
    expect(err.join('')).toMatch(/workspace-activity/)
  })

  it('--format json prints the raw {pending, stalled, latestEventAt} shape', () => {
    seed()
    const code = runCli(
      ['workspace-activity', '--workspace', 'ws-1', '--baseline-commit', 'c1', '--now', NOW, '--format', 'json'],
      io(root),
    )
    expect(code).toBe(0)
    const obj = JSON.parse(out.join(''))
    expect(obj).toHaveProperty('pending')
    expect(obj).toHaveProperty('stalled')
    expect(Array.isArray(obj.stalled)).toBe(true)
    expect(obj).toHaveProperty('latestEventAt')
  })

  it('a stalled in-progress item (older than idle window, injected --now) appears with its reason', () => {
    const { inProgressId } = seed()
    const code = runCli(
      ['workspace-activity', '--workspace', 'ws-1', '--baseline-commit', 'c1', '--now', NOW, '--format', 'json'],
      io(root),
    )
    expect(code).toBe(0)
    const obj = JSON.parse(out.join(''))
    const item = obj.stalled.find((s: { id: string }) => s.id === inProgressId)
    expect(item).toBeDefined()
    expect(item.reason).toBe('in-progress-idle')
  })

  it('--format text prints a readable summary (pending, each stalled item with reason, latestEventAt)', () => {
    const { inProgressId } = seed()
    const code = runCli(['workspace-activity', '--workspace', 'ws-1', '--baseline-commit', 'c1', '--now', NOW], io(root))
    expect(code).toBe(0)
    const text = out.join('')
    expect(text).toMatch(/pending: \d+/)
    expect(text).toMatch(/in-progress-idle/)
    expect(text).toContain(inProgressId)
    expect(text).toMatch(/latestEventAt/)
  })

  it('no .track resolves → graceful empty + rc=0 (never crash)', () => {
    // A fresh dir with NO `.track` ancestor (the suite's `root/.track` must not be found by the walk-up).
    const unadopted = mkdtempSync(join(tmpdir(), 'track-wsact-unadopted-'))
    try {
      const code = runCli(['workspace-activity', '--workspace', 'ws-1', '--now', NOW, '--format', 'json'], io(unadopted))
      expect(code).toBe(0)
      expect(err.join('')).toMatch(/track init/)
      const obj = JSON.parse(out.join(''))
      expect(obj.pending).toBe(0)
      expect(obj.stalled).toEqual([])
      expect(existsSync(join(unadopted, '.track'))).toBe(false)
    } finally {
      rmSync(unadopted, { recursive: true, force: true })
    }
  })

  it('performs NO append — event count is unchanged after the verb', () => {
    seed()
    const before = readFileSync(eventsPath, 'utf8')
    runCli(['workspace-activity', '--workspace', 'ws-1', '--baseline-commit', 'c1', '--now', NOW], io(root))
    const after = readFileSync(eventsPath, 'utf8')
    expect(after).toBe(before)
  })
})
