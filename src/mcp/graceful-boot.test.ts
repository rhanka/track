// Launch/serve alignment (fix): track-mcp must BOOT GRACEFULLY when no `.track` resolves — like h2a
// `mcp-serve`. It advertises tools, serves honest-empty read payloads + an init hint, NEVER creates a
// store, and picks up a `.track` created AFTER boot (lazy per-call resolution). Invalid args still error.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { EventStore } from '../events/store.js'
import { Track } from '../track.js'
import { createTrackMcpServer } from './server.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'track-mcp-boot-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

type ToolResult = {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

async function connect(server: ReturnType<typeof createTrackMcpServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0' }, { capabilities: {} })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

function jsonOf(res: ToolResult): unknown {
  return JSON.parse(res.content[0]!.text)
}
function hintText(res: ToolResult): string {
  return res.content.map((c) => c.text).join('\n')
}

describe('track-mcp — graceful boot with NO .track (serve-empty, no create)', () => {
  it('boots and serves tools/list when the store is unresolved (no dir created)', async () => {
    // An options-form server whose cwd has no ancestor .track — must NOT throw at construction.
    const sub = join(root, 'no', 'track', 'here')
    mkdirSync(sub, { recursive: true })
    const server = createTrackMcpServer({ cwd: sub })
    const client = await connect(server)

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('track_report')

    // No .track was materialized anywhere just by booting / listing.
    expect(existsSync(join(sub, '.track'))).toBe(false)
    expect(existsSync(join(root, '.track'))).toBe(false)

    await client.close()
  })

  it('serves honest-empty read payloads with isError !== true + a `track init` hint', async () => {
    const sub = join(root, 'unadopted')
    mkdirSync(sub, { recursive: true })
    const client = await connect(createTrackMcpServer({ cwd: sub }))

    const report = (await client.callTool({ name: 'track_report', arguments: { baselineCommit: 'c1' } })) as ToolResult
    expect(report.isError).not.toBe(true)
    expect((jsonOf(report) as { buckets: Record<string, unknown[]> }).buckets['AWAITED']).toEqual([])
    expect(hintText(report)).toMatch(/track init/)

    const query = (await client.callTool({ name: 'track_query', arguments: { baselineCommit: 'c1' } })) as ToolResult
    expect(query.isError).not.toBe(true)
    expect(jsonOf(query)).toEqual([])

    const validate = (await client.callTool({ name: 'track_validate', arguments: {} })) as ToolResult
    expect(validate.isError).not.toBe(true)
    expect(jsonOf(validate)).toMatchObject({ ok: true, findings: [] })

    const prov = (await client.callTool({ name: 'track_branch_provenance', arguments: { locator: 'x' } })) as ToolResult
    expect(prov.isError).not.toBe(true)
    expect(jsonOf(prov)).toBeNull()

    const fresh = (await client.callTool({ name: 'track_freshness', arguments: { locator: 'x', content: '# y' } })) as ToolResult
    expect(fresh.isError).not.toBe(true)
    expect(jsonOf(fresh)).toMatchObject({ status: 'absent' })

    const ext = (await client.callTool({ name: 'track_external_deps', arguments: {} })) as ToolResult
    expect(ext.isError).not.toBe(true)
    expect(jsonOf(ext)).toEqual([])

    // Still no store created by any read.
    expect(existsSync(join(sub, '.track'))).toBe(false)

    await client.close()
  })

  it('invalid args STILL return isError:true even on an unresolved store', async () => {
    const sub = join(root, 'unadopted2')
    mkdirSync(sub, { recursive: true })
    const client = await connect(createTrackMcpServer({ cwd: sub }))

    const missing = (await client.callTool({ name: 'track_report', arguments: {} })) as ToolResult
    expect(missing.isError).toBe(true)

    const badEnum = (await client.callTool({
      name: 'track_query',
      arguments: { baselineCommit: 'c1', bucket: 'NOPE' },
    })) as ToolResult
    expect(badEnum.isError).toBe(true)

    await client.close()
  })

  it('picks up a .track created AFTER boot (lazy per-call resolution, no restart)', async () => {
    const client = await connect(createTrackMcpServer({ cwd: root }))

    // Before: empty.
    const before = (await client.callTool({ name: 'track_query', arguments: { baselineCommit: 'c1' } })) as ToolResult
    expect(jsonOf(before)).toEqual([])

    // Create + populate a .track at the booted cwd AFTER the server is already serving.
    const eventsPath = join(root, '.track', 'events.jsonl')
    const track = new Track(new EventStore(eventsPath), { by: 'tester' })
    track.createItem({ kind: 'chore', title: 'late', workspace: 'ws' })

    // After: the same connected server now sees the freshly-created store — no hint, real rows.
    const after = (await client.callTool({ name: 'track_query', arguments: { baselineCommit: 'c1' } })) as ToolResult
    expect((jsonOf(after) as unknown[]).length).toBeGreaterThan(0)
    expect(hintText(after)).not.toMatch(/track init/)

    await client.close()
  })

  it('a bad explicit --track-dir override stays LOUD (read error, not empty-serve)', async () => {
    const client = await connect(createTrackMcpServer({ cwd: root, flag: join(root, 'does-not-exist') }))
    const res = (await client.callTool({ name: 'track_query', arguments: { baselineCommit: 'c1' } })) as ToolResult
    expect(res.isError).toBe(true)
    await client.close()
  })
})
