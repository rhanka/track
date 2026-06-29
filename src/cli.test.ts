import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from './events/store.js'
import { Track } from './track.js'
import { runCli, type CliIO } from './cli/index.js'

const FIXTURE = `# Feature: BR-99 — Demo Feature

## Objective
Demonstrate the CLI.

## Plan / Todo (lot-based)
- [x] **Lot 0 — Scaffold the thing**
- [ ] **Lot 1 — Core logic**
  - [x] UAT: web app loads
`

let dir: string
let out: string[]
let io: CliIO

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-cli-'))
  out = []
  io = { cwd: dir, out: (s) => out.push(s), err: (s) => out.push(s) }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('CLI smoke (Milestone 1): init -> branch import -> report', () => {
  it('imports a BRANCH.md and reports, leaving the file byte-identical (read-only)', () => {
    const branchFile = join(dir, 'BRANCH.md')
    writeFileSync(branchFile, FIXTURE)
    const hashBefore = sha256File(branchFile)

    expect(runCli(['init'], io)).toBe(0)
    // relative path is resolved against io.cwd, not process.cwd
    expect(runCli(['branch', 'import', 'BRANCH.md', '--commit', 'c1'], io)).toBe(0)
    expect(runCli(['report', '--format', 'text', '--commit', 'c1'], io)).toBe(0)

    const text = out.join('')
    expect(text).toContain('Initialized .track/')
    expect(text).toContain('Imported br-99: 4 created') // feature + 2 lots + 1 UAT criterion
    expect(text).toContain('SYNTHÈSE')
    expect(text).toContain('DÉCISIONS/ACTIONS')
    expect(text).toContain('Scaffold the thing')

    out = []
    expect(runCli(['report', '--flat', '--format', 'text', '--commit', 'c1'], io)).toBe(0)
    expect(out.join('')).toContain('DONE (1)') // Lot 0 done in legacy full dump

    // BRANCH.md is the source of truth — the importer must never write it.
    expect(sha256File(branchFile)).toBe(hashBefore)
  })

  it('report --format md renders markdown headings', () => {
    const branchFile = join(dir, 'BRANCH.md')
    writeFileSync(branchFile, FIXTURE)
    runCli(['init'], io)
    runCli(['branch', 'import', branchFile, '--commit', 'c1'], io)
    out = []
    runCli(['report', '--format', 'md', '--commit', 'c1'], io)
    expect(out.join('')).toContain('## SYNTHÈSE')
    expect(out.join('')).toContain('## DÉCISIONS/ACTIONS')
    expect(out.join('')).toContain('scope/gate')
    expect(out.join('')).toContain('préconisation')
  })

  it('prints usage and returns non-zero on an unknown command', () => {
    expect(runCli(['frobnicate'], io)).toBe(2)
    expect(out.join('')).toContain('usage: track')
  })

  it('prints the package version on --version / -v / version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    for (const flag of ['--version', '-v', 'version']) {
      out.length = 0
      expect(runCli([flag], io)).toBe(0)
      expect(out.join('').trim()).toBe(pkg.version)
    }
  })
})

describe('CLI full verb surface (Lot 7) end-to-end', () => {
  function r(args: string[]): { code: number; text: string } {
    out.length = 0
    // sync commands only here → runCli returns a plain number (the async `focus` path is not exercised)
    const code = runCli(args, io) as number
    return { code, text: out.join('').trim() }
  }

  it('drives item / blocker / accept / priority / decision / query / report / validate', () => {
    expect(r(['init']).code).toBe(0)

    const itemId = r(['item', 'new', '--kind', 'feature', '--title', 'Login', '--workspace', 'ws']).text
    expect(itemId.length).toBeGreaterThan(0)
    expect(r(['item', 'spec', itemId, 'specified']).code).toBe(0)
    expect(r(['item', 'realize', itemId, 'in-progress']).code).toBe(0)

    const refId = r(['item', 'new', '--kind', 'chore', '--title', 'Dep', '--workspace', 'ws']).text
    const blockerId = r([
      'blocker', 'raise', '--target', itemId, '--kind', 'dependency', '--ref', refId, '--rule', 'manual', '--reason', 'x',
    ]).text
    expect(r(['blocker', 'resolve', blockerId]).code).toBe(0)

    const critId = r(['accept', 'criterion', itemId, '--statement', 'user logs in']).text
    const evId = r(['accept', 'link', critId, '--kind', 'e2e', '--locator', 't1']).text
    expect(r(['accept', 'run', evId, '--result', 'pass', '--commit', 'c1']).code).toBe(0)

    expect(r(['priority', 'assess', itemId, '--ubv', '8', '--tc', '2', '--rr', '0', '--js', '2']).text).toContain(
      'wsjf score 5',
    )

    const decId = r(['decision', 'new', '--kind', 'orientation', '--title', 'go?', '--workspace', 'ws', '--targets', refId]).text
    expect(r(['decision', 'outcome', decId, 'go']).code).toBe(0)

    expect(r(['query', '--kind', 'feature', '--format', 'json', '--commit', 'c1']).text).toContain(itemId)
    expect(r(['report', '--decisions', '--commit', 'c1']).code).toBe(0)

    const v = r(['validate', '--commit', 'c1'])
    expect(v.code).toBe(0)
    expect(v.text).toContain('OK')

    expect(r(['item', 'show', itemId]).text).toContain('"specStatus": "specified"')
  })

  it('consolidate --items --commit heals a done+accepted item + is client-token idempotent', () => {
    expect(r(['init']).code).toBe(0)
    const itemId = r(['item', 'new', '--kind', 'feature', '--title', 'F', '--workspace', 'ws']).text
    const critId = r(['accept', 'criterion', itemId, '--statement', 'works']).text
    const evId = r(['accept', 'link', critId, '--kind', 'unit', '--locator', 't1']).text
    r(['accept', 'run', evId, '--result', 'pass', '--commit', 'c1'])
    r(['item', 'realize', itemId, 'in-progress'])
    r(['item', 'realize', itemId, 'done'])
    // unrelated merge moved HEAD to c2 → strict stale; a requireAccepted report buckets it TO-DO
    expect(r(['query', '--workspace', 'ws', '--acceptance', 'stale', '--commit', 'c2', '--format', 'json']).text).toContain(itemId)
    // consolidate at c2 re-anchors + re-stamps the pass run → reads pass at c2
    expect(r(['consolidate', '--items', itemId, '--commit', 'c2', '--client-token', 'tk1']).text).toBe('ok')
    expect(r(['query', '--workspace', 'ws', '--acceptance', 'pass', '--commit', 'c2', '--format', 'json']).text).toContain(itemId)
    // a retried --client-token is a no-op
    expect(r(['consolidate', '--items', itemId, '--commit', 'c2', '--client-token', 'tk1']).text).toContain('no-op')
  })

  it('item assign-code: renders the stable code in the report, roster-global unique', () => {
    expect(r(['init']).code).toBe(0)
    const wp1 = r(['item', 'new', '--kind', 'chore', '--title', 'Alpha', '--workspace', 'ws', '--role', 'workpackage']).text
    const wp2 = r(['item', 'new', '--kind', 'chore', '--title', 'Beta', '--workspace', 'ws', '--role', 'workpackage']).text
    r(['item', 'new', '--kind', 'chore', '--title', 'leaf', '--workspace', 'ws', '--parent', wp1])
    // assign a stable code; the report renders it verbatim (decoupled from positional WPn)
    expect(r(['item', 'assign-code', wp1, '--code', 'WP7']).text).toContain('WP7')
    expect(r(['report', '--commit', 'c1']).text).toContain('WP7')
    // roster-global uniqueness: a 2nd root reusing the code is rejected fail-closed (rc=1)
    expect(r(['item', 'assign-code', wp2, '--code', 'WP7']).code).toBe(1)
    // client-token idempotency: a retried assign is a no-op
    expect(r(['item', 'assign-code', wp1, '--code', 'WP7', '--client-token', 'ac1']).code).toBe(0)
    expect(r(['item', 'assign-code', wp1, '--code', 'WP7', '--client-token', 'ac1']).text).toContain('no-op')
  })

  it('a domain error returns exit 1 with a message', () => {
    runCli(['init'], io)
    const id = (() => {
      out.length = 0
      runCli(['item', 'new', '--kind', 'feature', '--title', 'X', '--workspace', 'ws'], io)
      return out.join('').trim()
    })()
    out.length = 0
    // to-do -> done is illegal (must pass through in-progress)
    expect(runCli(['item', 'realize', id, 'done'], io)).toBe(1)
    expect(out.join('')).toContain('error: ')
  })

  it('validate flags a desync when an item body references a missing markdown', () => {
    runCli(['init'], io)
    runCli(['item', 'new', '--kind', 'feature', '--title', 'Spec', '--workspace', 'ws', '--body', 'docs/missing.md'], io)
    out.length = 0
    expect(runCli(['validate', '--commit', 'c1'], io)).toBe(1)
    const text = out.join('')
    expect(text).toContain('desync')
    expect(text).toContain('missing')
    // v2.2c: each desync finding carries a remediation hint (detect-only, never auto-applied).
    expect(text).toContain('hint')
    expect(text).toContain('create') // the hint suggests creating the missing file
  })
})

describe('CLI input validation + review fixes (Lot 7)', () => {
  function last(args: string[]): string {
    out.length = 0
    runCli(args, io)
    return out.join('').trim()
  }

  it('rejects invalid enum inputs and a missing required flag (exit 1)', () => {
    runCli(['init'], io)
    out.length = 0
    expect(runCli(['item', 'new', '--kind', 'bogus', '--title', 't', '--workspace', 'ws'], io)).toBe(1)
    expect(out.join('')).toContain('--kind must be one of')
    out.length = 0
    expect(runCli(['query', '--bucket', 'NOPE'], io)).toBe(1)
    out.length = 0
    expect(runCli(['item', 'new', '--kind', 'feature', '--title', 't'], io)).toBe(1) // no --workspace
    expect(out.join('')).toContain('--workspace')
  })

  it('rejects an invalid --result (no silent pass)', () => {
    runCli(['init'], io)
    const id = last(['item', 'new', '--kind', 'feature', '--title', 't', '--workspace', 'ws'])
    const c = last(['accept', 'criterion', id, '--statement', 's'])
    const e = last(['accept', 'link', c, '--kind', 'unit', '--locator', 'l'])
    out.length = 0
    expect(runCli(['accept', 'run', e, '--result', 'maybe'], io)).toBe(1)
    expect(out.join('')).toContain('--result must be one of')
  })

  it('blocker raise --kind decision resolves a real decision ref', () => {
    runCli(['init'], io)
    const t = last(['item', 'new', '--kind', 'feature', '--title', 't', '--workspace', 'ws'])
    const d = last(['decision', 'new', '--kind', 'orientation', '--title', 'x', '--workspace', 'ws', '--targets', t])
    out.length = 0
    expect(runCli(['blocker', 'raise', '--target', t, '--kind', 'decision', '--ref', d], io)).toBe(0)
    expect(out.join('').trim().length).toBeGreaterThan(0) // a blockerId
  })

  it('decision dossier --context merges, preserving existing options', () => {
    runCli(['init'], io)
    const store = new EventStore(join(dir, '.track', 'events.jsonl'))
    const track = new Track(store)
    const t = track.createItem({ kind: 'feature', title: 't', workspace: 'ws' })
    const d = track.createDecision({
      decisionKind: 'orientation',
      title: 'x',
      workspace: 'ws',
      targets: [t],
      dossier: { context: 'old', options: [{ id: 'o1', title: 'A', summary: 's' }], qa: [] },
    })
    out.length = 0
    expect(runCli(['decision', 'dossier', d, '--context', 'new'], io)).toBe(0)
    const dossier = new Track(store).state().decisions.get(d)!.dossier
    expect(dossier.context).toBe('new')
    expect(dossier.options).toHaveLength(1) // preserved, not erased
  })

  it('decision add-artifact appends a rendered-view (parity with the lib/ingest path)', () => {
    runCli(['init'], io)
    const store = new EventStore(join(dir, '.track', 'events.jsonl'))
    const track = new Track(store)
    const t = track.createItem({ kind: 'feature', title: 't', workspace: 'ws' })
    const d = track.createDecision({
      decisionKind: 'orientation',
      title: 'x',
      workspace: 'ws',
      targets: [t],
      dossier: { context: 'c', options: [], qa: [] },
    })
    out.length = 0
    expect(
      runCli(
        ['decision', 'add-artifact', d, '--kind', 'rendered-view', '--view-ref', 'track://dossier/1', '--source-dossier-hash', 'sha256:abc', '--label', 'card'],
        io,
      ),
    ).toBe(0)
    const dossier = new Track(store).state().decisions.get(d)!.dossier
    expect(dossier.context).toBe('c') // existing dossier untouched (append, not rewrite)
    expect(dossier.artifacts).toEqual([
      { kind: 'rendered-view', viewRef: 'track://dossier/1', sourceDossierHash: 'sha256:abc', label: 'card' },
    ])
  })

  it('decision add-artifact appends an h2a-decision-dossier (negotiation-ref + dossier-hash)', () => {
    runCli(['init'], io)
    const store = new EventStore(join(dir, '.track', 'events.jsonl'))
    const track = new Track(store)
    const t = track.createItem({ kind: 'feature', title: 't', workspace: 'ws' })
    const d = track.createDecision({ decisionKind: 'orientation', title: 'x', workspace: 'ws', targets: [t], dossier: { context: '', options: [], qa: [] } })
    out.length = 0
    expect(
      runCli(['decision', 'add-artifact', d, '--kind', 'h2a-decision-dossier', '--negotiation-ref', 'neg-1', '--dossier-hash', 'sha256:x'], io),
    ).toBe(0)
    const dossier = new Track(store).state().decisions.get(d)!.dossier
    expect(dossier.artifacts).toEqual([{ kind: 'h2a-decision-dossier', negotiationRef: 'neg-1', dossierHash: 'sha256:x' }])
  })

  it('decision add-artifact rejects a malformed union (exit 1)', () => {
    runCli(['init'], io)
    const store = new EventStore(join(dir, '.track', 'events.jsonl'))
    const track = new Track(store)
    const t = track.createItem({ kind: 'feature', title: 't', workspace: 'ws' })
    const d = track.createDecision({ decisionKind: 'orientation', title: 'x', workspace: 'ws', targets: [t], dossier: { context: '', options: [], qa: [] } })
    out.length = 0
    // h2a-decision-dossier with no dossier-hash → fail-closed
    expect(runCli(['decision', 'add-artifact', d, '--kind', 'h2a-decision-dossier', '--negotiation-ref', 'neg-1'], io)).toBe(1)
    expect(out.join('')).toContain('dossierHash')
    out.length = 0
    // rendered-view with no view-ref → fail-closed
    expect(runCli(['decision', 'add-artifact', d, '--kind', 'rendered-view'], io)).toBe(1)
    expect(out.join('')).toContain('viewRef')
    // nothing was appended
    expect(new Track(store).state().decisions.get(d)!.dossier.artifacts).toBeUndefined()
  })

  it('decision add-artifact honors --client-token idempotency (appends once)', () => {
    runCli(['init'], io)
    const store = new EventStore(join(dir, '.track', 'events.jsonl'))
    const track = new Track(store)
    const t = track.createItem({ kind: 'feature', title: 't', workspace: 'ws' })
    const d = track.createDecision({ decisionKind: 'orientation', title: 'x', workspace: 'ws', targets: [t], dossier: { context: '', options: [], qa: [] } })
    const args = ['decision', 'add-artifact', d, '--kind', 'rendered-view', '--view-ref', 'track://dossier/1', '--client-token', 'tok-1']
    out.length = 0
    expect(runCli(args, io)).toBe(0)
    expect(runCli(args, io)).toBe(0) // re-send with same token
    const dossier = new Track(store).state().decisions.get(d)!.dossier
    expect(dossier.artifacts).toEqual([{ kind: 'rendered-view', viewRef: 'track://dossier/1' }]) // appended ONCE
  })

  it('decision usage names add-artifact', () => {
    runCli(['init'], io)
    out.length = 0
    expect(runCli(['decision', 'bogus-sub'], io)).toBe(2)
    expect(out.join('')).toContain('add-artifact')
  })

  it('validate flags a referenced markdown with no H1', () => {
    runCli(['init'], io)
    writeFileSync(join(dir, 'prose.md'), 'no heading here\n')
    runCli(['item', 'new', '--kind', 'feature', '--title', 'Spec', '--workspace', 'ws', '--body', 'prose.md'], io)
    out.length = 0
    expect(runCli(['validate', '--commit', 'c1'], io)).toBe(1)
    expect(out.join('')).toContain('no H1')
  })

  it('ships linked-accepted end-to-end: gate derived vs --commit and revocable', () => {
    runCli(['init'], io)
    const t = last(['item', 'new', '--kind', 'feature', '--title', 't', '--workspace', 'ws'])
    const ref = last(['item', 'new', '--kind', 'feature', '--title', 'r', '--workspace', 'ws'])
    const crit = last(['accept', 'criterion', ref, '--statement', 'r works'])
    const ev = last(['accept', 'link', crit, '--kind', 'unit', '--locator', 'r.test'])
    expect(
      runCli(['blocker', 'raise', '--target', t, '--kind', 'dependency', '--ref', ref, '--rule', 'linked-accepted', '--reason', 'needs r'], io),
    ).toBe(0)

    const awaitedHasT = (commit: string): boolean => {
      out.length = 0
      runCli(['query', '--bucket', 'AWAITED', '--format', 'json', '--commit', commit], io)
      return out.join('').includes(t)
    }
    expect(awaitedHasT('c1')).toBe(true) // R unknown → t AWAITED
    runCli(['accept', 'run', ev, '--result', 'pass', '--commit', 'c1'], io)
    expect(awaitedHasT('c1')).toBe(false) // R pass @ c1 → gate closed
    runCli(['accept', 'run', ev, '--result', 'fail', '--commit', 'c1'], io)
    expect(awaitedHasT('c1')).toBe(true) // regression → re-AWAITED, no new blocker
  })

  it('still rejects an unqueryable n/a acceptance value', () => {
    runCli(['init'], io)
    expect(runCli(['query', '--acceptance', 'n/a'], io)).toBe(1)
  })

  it('attributes CLI writes to the local user with cli provenance (D3 — never system)', () => {
    runCli(['init'], io)
    last(['item', 'new', '--kind', 'feature', '--title', 't', '--workspace', 'ws'])
    const lines = readFileSync(join(dir, '.track', 'events.jsonl'), 'utf8').trim().split('\n')
    const created = JSON.parse(lines.find((l) => l.includes('"item.created"'))!)
    expect(created.by).not.toBe('system')
    expect(created.by).toMatch(/^(human:|cli:)/)
    expect(created.prov).toMatchObject({ transport: 'cli', proposed: false, auth: 'local-user' })
  })
})
