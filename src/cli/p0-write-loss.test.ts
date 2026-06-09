import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EventStore } from '../events/store.js'
import { runCli, type CliIO } from './index.js'

let root: string
let out: string[]
let err: string[]

function io(cwd: string): CliIO {
  return { cwd, out: (s) => out.push(s), err: (s) => err.push(s) }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'track-p0-'))
  out = []
  err = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('P0 — cwd regression: a write from a subdir advances the ROOT .track', () => {
  it('item new from repo/subdir advances root .track/events.jsonl and creates NO subdir/.track', () => {
    expect(runCli(['init'], io(root))).toBe(0)
    const sub = join(root, 'subdir', 'deeper')
    mkdirSync(sub, { recursive: true })

    out = []
    err = []
    const code = runCli(['item', 'new', '--kind', 'feature', '--title', 'X', '--workspace', 'ws'], io(sub))
    expect(code).toBe(0)

    // the ROOT sidecar was advanced…
    const rootLog = join(root, '.track', 'events.jsonl')
    expect(existsSync(rootLog)).toBe(true)
    expect(readFileSync(rootLog, 'utf8').trim().split('\n')).toHaveLength(1)
    // …and NO stray .track was auto-created under the subdir.
    expect(existsSync(join(sub, '.track'))).toBe(false)
    expect(existsSync(join(root, 'subdir', '.track'))).toBe(false)
  })

  it('a mutating command FAILS LOUD (rc=1 + stderr) when no .track exists upward', () => {
    const sub = join(root, 'no-track-here')
    mkdirSync(sub, { recursive: true })
    const code = runCli(['item', 'new', '--kind', 'feature', '--title', 'X', '--workspace', 'ws'], io(sub))
    expect(code).toBe(1)
    expect(err.join('')).toMatch(/\.track/)
    expect(existsSync(join(sub, '.track'))).toBe(false)
  })

  it('init is the ONLY command that creates a new .track', () => {
    const fresh = join(root, 'fresh')
    mkdirSync(fresh, { recursive: true })
    expect(runCli(['init'], io(fresh))).toBe(0)
    expect(existsSync(join(fresh, '.track'))).toBe(true)
  })
})

describe('P0 — append guard: a no-op appendAtomic must not pass as success', () => {
  it('appendCommand THROWS "append verification failed" when the write does not persist', () => {
    mkdirSync(join(root, '.track'), { recursive: true })
    const store = new EventStore(join(root, '.track', 'events.jsonl'))
    // Stub the physical append to a no-op: writeHead still advances, but the log never grows.
    const spy = vi.spyOn(store as unknown as { appendAtomic: (e: unknown) => void }, 'appendAtomic')
    spy.mockImplementation(() => {})
    expect(() =>
      store.appendCommand([
        {
          id: 'evt-1',
          type: 'item.created',
          aggregate: 'item',
          aggregateId: 'item-A',
          at: '2026-06-09T10:00:00.000Z',
          by: 'tester',
          payload: { k: 1 },
        },
      ]),
    ).toThrow(/append verification failed/)
  })

  it('the CLI returns rc=1 when the underlying append fails verification', () => {
    expect(runCli(['init'], io(root))).toBe(0)
    // Patch EventStore.prototype.appendAtomic so the CLI-built store also no-ops its physical write.
    const proto = EventStore.prototype as unknown as { appendAtomic: (e: unknown) => void }
    const spy = vi.spyOn(proto, 'appendAtomic').mockImplementation(() => {})
    out = []
    err = []
    const code = runCli(['item', 'new', '--kind', 'feature', '--title', 'X', '--workspace', 'ws'], io(root))
    spy.mockRestore()
    expect(code).toBe(1)
    expect(err.join('')).toMatch(/append verification failed/)
  })
})

describe('P0 — lock fail-loud: a live .lock never yields rc=0', () => {
  it('a mutating command returns rc=1 + clear stderr (never rc=0) on a held lock', () => {
    expect(runCli(['init'], io(root))).toBe(0)
    const lockPath = join(root, '.track', 'events.jsonl.lock')
    // A live holder (THIS pid) ⇒ diagnose reports RUNNING; the store must fail-closed, not no-op.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: 'h', time: Date.now(), token: 't' }))
    const prev = process.env['TRACK_LOCK_TIMEOUT_MS']
    process.env['TRACK_LOCK_TIMEOUT_MS'] = '120' // keep the test fast; default is 10s
    out = []
    err = []
    const code = runCli(['item', 'new', '--kind', 'feature', '--title', 'X', '--workspace', 'ws'], io(root))
    if (prev === undefined) delete process.env['TRACK_LOCK_TIMEOUT_MS']
    else process.env['TRACK_LOCK_TIMEOUT_MS'] = prev
    rmSync(lockPath, { force: true })
    expect(code).toBe(1)
    expect(code).not.toBe(0)
    expect(err.join('')).toMatch(/timed out|lock/i)
  })
})

describe('P0 — explicit no-op writes say "no-op" (whitelisted, never silent ok)', () => {
  it('blocker resolve-external with 0 matches reports a no-op explicitly', () => {
    expect(runCli(['init'], io(root))).toBe(0)
    out = []
    err = []
    const code = runCli(['blocker', 'resolve-external', '--engagement-ref', 'eng:none'], io(root))
    expect(code).toBe(0)
    expect(out.join('')).toMatch(/no-op|resolved 0/)
  })
})
