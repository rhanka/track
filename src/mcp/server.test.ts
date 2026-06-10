import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { runCli, type CliIO } from '../cli/index.js'
import { EventStore } from '../events/store.js'
import { TrackReader } from '../read/contract.js'
import { Track } from '../track.js'
import { READ_TOOLS, createTrackMcpServer, dispatchReadTool } from './server.js'

let dir: string
let eventsPath: string
let reader: TrackReader

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-mcp-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  let n = 0
  const track = new Track(new EventStore(eventsPath), {
    by: 'tester',
    now: () => '2026-06-05T10:00:00.000Z',
    newId: () => `id-${String(++n).padStart(4, '0')}`,
  })
  // Fixture: a blocked feature (AWAITED) + a plain chore (TO-DO) → non-empty report across buckets.
  const a = track.createItem({ kind: 'feature', title: 'A', workspace: 'ws' })
  const dep = track.createItem({ kind: 'chore', title: 'dep', workspace: 'ws' })
  track.openBlocker({ targetId: a, kind: 'dependency', ref: dep, reason: 'needs dep' })
  reader = new TrackReader(eventsPath)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function cliOut(args: string[]): string {
  const buf: string[] = []
  const io: CliIO = { cwd: dir, out: (s) => buf.push(s), err: (s) => buf.push(s) }
  runCli(args, io)
  return buf.join('')
}

describe('MCP read server — tool surface', () => {
  it('exposes exactly the read-only tools', () => {
    expect(READ_TOOLS.map((t) => t.name).sort()).toEqual([
      'track_amendment_trace',
      'track_branch_provenance',
      'track_canevas',
      'track_cursor',
      'track_external_deps',
      'track_freshness',
      'track_query',
      'track_report',
      'track_scope_validate',
      'track_status',
      'track_validate',
      'track_verification_runs',
      'track_workspace_activity',
    ])
  })

  it('constructs a server without throwing', () => {
    expect(() => createTrackMcpServer(eventsPath)).not.toThrow()
  })
})

describe('MCP read server — CLI≡MCP parity (same shared command layer)', () => {
  it('track_report output is byte-identical to `report --format json --commit`', () => {
    expect(dispatchReadTool(reader, 'track_report', { baselineCommit: 'c1' })).toBe(
      cliOut(['report', '--format', 'json', '--commit', 'c1']),
    )
  })

  it('track_query output is byte-identical to `query --format json --commit`', () => {
    expect(dispatchReadTool(reader, 'track_query', { baselineCommit: 'c1' })).toBe(
      cliOut(['query', '--format', 'json', '--commit', 'c1']),
    )
  })

  it('track_query honours filters identically to the CLI', () => {
    expect(dispatchReadTool(reader, 'track_query', { baselineCommit: 'c1', bucket: 'AWAITED' })).toBe(
      cliOut(['query', '--bucket', 'AWAITED', '--format', 'json', '--commit', 'c1']),
    )
  })
})

describe('MCP read server — semantics', () => {
  it('track_validate returns the integrity result (ok on a clean log)', () => {
    expect(JSON.parse(dispatchReadTool(reader, 'track_validate', {})).ok).toBe(true)
  })

  it('rejects missing/invalid required args', () => {
    expect(() => dispatchReadTool(reader, 'track_report', {})).toThrow(/baselineCommit/)
    expect(() => dispatchReadTool(reader, 'track_branch_provenance', {})).toThrow(/locator/)
    expect(() => dispatchReadTool(reader, 'nope', {})).toThrow(/unknown tool/)
  })

  it('read tools NEVER append to the event log (side-effect-free)', () => {
    const before = new EventStore(eventsPath).readAll().length
    dispatchReadTool(reader, 'track_report', { baselineCommit: 'c1' })
    dispatchReadTool(reader, 'track_query', { baselineCommit: 'c1' })
    dispatchReadTool(reader, 'track_validate', {})
    dispatchReadTool(reader, 'track_branch_provenance', { locator: 'x' })
    dispatchReadTool(reader, 'track_freshness', { locator: 'x', content: '# y' })
    dispatchReadTool(reader, 'track_workspace_activity', {
      workspace: 'ws',
      baselineCommit: 'c1',
      now: '2026-06-05T10:00:00.000Z',
    })
    expect(new EventStore(eventsPath).readAll().length).toBe(before)
  })

  it('track_workspace_activity == the library result (same args)', () => {
    const args = { workspace: 'ws', baselineCommit: 'c1', now: '2026-06-05T10:00:00.000Z' }
    expect(dispatchReadTool(reader, 'track_workspace_activity', args)).toBe(
      JSON.stringify(reader.workspaceActivity('ws', { baselineCommit: 'c1', now: args.now }), null, 2),
    )
  })

  it('track_workspace_activity rejects missing required args (workspace, now)', () => {
    expect(() => dispatchReadTool(reader, 'track_workspace_activity', { baselineCommit: 'c1', now: 'x' })).toThrow(/workspace/)
    expect(() => dispatchReadTool(reader, 'track_workspace_activity', { workspace: 'ws', baselineCommit: 'c1' })).toThrow(/now/)
  })
})

describe('MCP read server — arg validation (parity strictness with the CLI)', () => {
  it('rejects an invalid enum filter (not silently empty, like CLI oneOf)', () => {
    expect(() => dispatchReadTool(reader, 'track_query', { baselineCommit: 'c1', bucket: 'NOPE' })).toThrow(/bucket/)
  })

  it('rejects a non-boolean requireAccepted (no silent coercion)', () => {
    expect(() => dispatchReadTool(reader, 'track_report', { baselineCommit: 'c1', requireAccepted: 'true' })).toThrow(/requireAccepted/)
  })
})

describe('MCP read server — non-query tool shapes & edges', () => {
  it('track_branch_provenance returns null when never imported', () => {
    expect(dispatchReadTool(reader, 'track_branch_provenance', { locator: 'plan/none.md' })).toBe('null')
  })

  it('track_freshness returns a status object', () => {
    const f = JSON.parse(dispatchReadTool(reader, 'track_freshness', { locator: 'x', content: '# y' }))
    expect(f.status).toBe('absent')
  })

  it('works on an empty / absent log (report + validate)', () => {
    // A fresh dir with no head.json — so readHead returns null (not the fixture's anchor).
    const emptyDir = mkdtempSync(join(tmpdir(), 'track-mcp-empty-'))
    try {
      const empty = new TrackReader(join(emptyDir, '.track', 'events.jsonl'))
      expect(JSON.parse(dispatchReadTool(empty, 'track_validate', {})).ok).toBe(true)
      expect(JSON.parse(dispatchReadTool(empty, 'track_report', { baselineCommit: 'c1' })).buckets.AWAITED).toEqual([])
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})

describe('MCP read server — real protocol round-trip (in-memory transport)', () => {
  it('serves tools/list and tools/call to a connected client', async () => {
    const server = createTrackMcpServer(eventsPath)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0' }, { capabilities: {} })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('track_report')

    const res = await client.callTool({ name: 'track_report', arguments: { baselineCommit: 'c1' } })
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text
    expect(text).toBe(dispatchReadTool(reader, 'track_report', { baselineCommit: 'c1' }))

    const bad = await client.callTool({ name: 'track_report', arguments: {} })
    expect(bad.isError).toBe(true)

    const badEnum = await client.callTool({ name: 'track_query', arguments: { baselineCommit: 'c1', bucket: 'NOPE' } })
    expect(badEnum.isError).toBe(true)

    // a second successful call on the same connected server (sequential calls re-read the log)
    const again = await client.callTool({ name: 'track_validate', arguments: {} })
    expect(JSON.parse((again.content as Array<{ text: string }>)[0]!.text).ok).toBe(true)

    await client.close()
  })
})
