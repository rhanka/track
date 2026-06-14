import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCli, type CliIO } from './cli/index.js'
import { EventStore } from './events/store.js'
import { Track } from './track.js'
import { TrackReader } from './read/contract.js'

let dir: string
let eventsPath: string
let track: Track

function validateGraphifyShape(fragment: unknown): string[] {
  if (typeof fragment !== 'object' || fragment === null || Array.isArray(fragment)) return ['not object']
  const f = fragment as Record<string, unknown>
  const errors: string[] = []
  const nodes = Array.isArray(f['nodes']) ? (f['nodes'] as Record<string, unknown>[]) : []
  const edges = Array.isArray(f['edges']) ? (f['edges'] as Record<string, unknown>[]) : []
  const nodeIds = new Set(nodes.map((n) => n['id']).filter((id): id is string => typeof id === 'string'))
  for (const key of ['nodes', 'edges', 'provenance']) if (!(key in f)) errors.push(`missing ${key}`)
  for (const [i, node] of nodes.entries()) {
    for (const key of ['id', 'label', 'file_type', 'source_file', 'node_type']) {
      if (!(key in node)) errors.push(`node ${i} missing ${key}`)
    }
  }
  for (const [i, edge] of edges.entries()) {
    for (const key of ['source', 'target', 'relation', 'confidence', 'source_file', 'from', 'to', 'relation_type']) {
      if (!(key in edge)) errors.push(`edge ${i} missing ${key}`)
    }
    if (typeof edge['source'] === 'string' && !nodeIds.has(edge['source'])) errors.push(`edge ${i} missing source node`)
    if (typeof edge['target'] === 'string' && !nodeIds.has(edge['target'])) errors.push(`edge ${i} missing target node`)
  }
  const provenance = f['provenance'] as Record<string, unknown> | undefined
  for (const key of ['source_owner', 'source_id', 'observed_at', 'source_hash', 'adapter_version']) {
    if (typeof provenance?.[key] !== 'string') errors.push(`provenance missing ${key}`)
  }
  return errors
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-graph-export-'))
  eventsPath = join(dir, '.track', 'events.jsonl')
  let n = 0
  track = new Track(new EventStore(eventsPath), {
    by: 'tester',
    now: () => '2026-06-13T10:00:00.000Z',
    newId: () => `id-${String(++n).padStart(4, '0')}`,
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('graph export', () => {
  it('exports a graphify Extraction fragment with EVIDENCED_BY commit edges derived from TestRun.commit', () => {
    const feature = track.createItem({ kind: 'feature', title: 'Login', workspace: 'ws' })
    const criterion = track.addCriterion(feature, 'user can log in')
    const evidence = track.linkEvidence(criterion, 'e2e', 'tests/login.spec.ts')
    track.recordRun(evidence, { commit: 'abc123', env: 'ci', runner: 'vitest', result: 'pass' })

    const blocker = track.openBlocker({ targetId: feature, kind: 'dependency', ref: feature, reason: 'self-check', resolutionRule: 'manual' })
    expect(blocker).toBeTruthy()

    const fragment = new TrackReader(eventsPath).graphExport({
      repoKey: 'repo:github.com/acme/app',
      sourceId: 'ws',
      observedAt: '2026-06-13T12:00:00.000Z',
    })

    expect(validateGraphifyShape(fragment)).toEqual([])
    expect(fragment.provenance).toMatchObject({ source_owner: 'track', source_id: 'ws' })
    expect(fragment.nodes.some((node) => node.id === feature && node.node_type === 'Feature')).toBe(true)
    expect(fragment.nodes.some((node) => node.id === criterion && node.node_type === 'AcceptanceCriterion')).toBe(true)
    expect(fragment.edges).toContainEqual(
      expect.objectContaining({
        source: criterion,
        target: 'commit:repo:github.com/acme/app@abc123',
        relation: 'EVIDENCED_BY',
        from: criterion,
        to: 'commit:repo:github.com/acme/app@abc123',
        relation_type: 'EVIDENCED_BY',
      }),
    )
  })

  it('prints the fragment through `track export-graph`', () => {
    const out: string[] = []
    const io: CliIO = { cwd: dir, out: (s) => out.push(s), err: (s) => out.push(s) }
    expect(runCli(['init'], io)).toBe(0)
    out.length = 0
    const feature = run(['item', 'new', '--kind', 'feature', '--title', 'Login', '--workspace', 'ws'], io)
    const criterion = run(['accept', 'criterion', feature, '--statement', 'user can log in'], io)
    const evidence = run(['accept', 'link', criterion, '--kind', 'unit', '--locator', 'tests/login.test.ts'], io)
    expect(runCli(['accept', 'run', evidence, '--result', 'pass', '--commit', 'abc123', '--env', 'ci', '--runner', 'vitest'], io)).toBe(0)

    out.length = 0
    expect(runCli(['export-graph', '--repo-key', 'repo:github.com/acme/app', '--source-id', 'ws'], io)).toBe(0)
    const fragment = JSON.parse(out.join('')) as ReturnType<TrackReader['graphExport']>
    expect(validateGraphifyShape(fragment)).toEqual([])
    expect(fragment.edges.some((edge) => edge.relation === 'EVIDENCED_BY' && edge.target === 'commit:repo:github.com/acme/app@abc123')).toBe(true)
  })
})

function run(args: string[], io: CliIO): string {
  const out: string[] = []
  const localIo: CliIO = { ...io, out: (s) => out.push(s), err: io.err }
  expect(runCli(args, localIo)).toBe(0)
  return out.join('').trim()
}
