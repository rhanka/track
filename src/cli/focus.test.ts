// `track focus <decision-id> --workspace <w> [--format terminal|md|html] [--baseline-commit <sha>]` —
// a READ-ONLY render verb that projects a track decision into a focus DecisionDossierDocument and renders
// it via the real `@sentropic/focus` (devDep here). track resolves the store THE TRACK WAY (ctx.eventsPath,
// no `--events-path`), then calls focus's `readDecisionDossier` + dispatches renderTerminal/Md/Html. v1 is
// read-only: no write, no `.track` creation. These tests use the REAL published `@sentropic/focus@^0.3.0`
// against a fixture log built by the local Track facade (npm dedupes to one major-compatible track read).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EventStore } from '../events/store.js'
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

const DECISION_TITLE = 'Ship track focus CLI'

/** Seed a `.track` log with ONE decision (kind=commitment, outcome=go) over a fixture target item. */
function seed(): { decisionId: string } {
  const track = new Track(new EventStore(eventsPath), { by: 'human:t@t' })
  const targetId = track.createItem({ kind: 'feature', title: 'Adopt focus', workspace: 'ws-1' })
  const decisionId = track.createDecision({
    decisionKind: 'commitment',
    title: DECISION_TITLE,
    workspace: 'ws-1',
    targets: [targetId],
    dossier: { context: 'We need a render path', options: [], qa: [] },
  })
  track.setOutcome(decisionId, 'go')
  return { decisionId }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'track-focus-'))
  trackDir = join(root, '.track')
  mkdirSync(trackDir, { recursive: true })
  eventsPath = join(trackDir, 'events.jsonl')
  out = []
  err = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('track focus', () => {
  it('renders the decision dossier to the terminal (default format) — contains the title + outcome', async () => {
    const { decisionId } = seed()
    const code = await runCli(['focus', decisionId, '--workspace', 'ws-1', '--baseline-commit', 'c1'], io(root))
    expect(code).toBe(0)
    const text = out.join('')
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain(DECISION_TITLE)
    // the `go` outcome is surfaced as a rendered outcome line (focus's GO ratification text)
    expect(text).toMatch(/GO/i)
  })

  it('--format md dispatches the markdown renderer (markdown headings, contains the title)', async () => {
    const { decisionId } = seed()
    const code = await runCli(
      ['focus', decisionId, '--workspace', 'ws-1', '--baseline-commit', 'c1', '--format', 'md'],
      io(root),
    )
    expect(code).toBe(0)
    const md = out.join('')
    expect(md).toContain(DECISION_TITLE)
    expect(md).toMatch(/^#/m) // an ATX markdown heading — proves renderMd, not renderTerminal
  })

  it('--format html dispatches the html renderer (HTML markup, escaped prose <pre>, contains the title)', async () => {
    const { decisionId } = seed()
    const code = await runCli(
      ['focus', decisionId, '--workspace', 'ws-1', '--baseline-commit', 'c1', '--format', 'html'],
      io(root),
    )
    expect(code).toBe(0)
    const html = out.join('')
    expect(html).toContain(DECISION_TITLE)
    expect(html).toMatch(/<[a-z]/i) // an HTML tag — proves renderHtml, not terminal/md
    // the HTML_HOOKS markdown hook wraps prose in a recognizable <pre class="focus-md-raw">
    expect(html).toContain('focus-md-raw')
  })

  it('missing --workspace → rc=2 + usage (workspace is REQUIRED, like the decision-id positional)', async () => {
    const { decisionId } = seed()
    const code = await runCli(['focus', decisionId, '--baseline-commit', 'c1'], io(root))
    expect(code).toBe(2)
    expect(err.join('')).toMatch(/focus/)
    expect(err.join('')).toMatch(/--workspace/)
  })

  it('missing decision-id → rc=2 + usage', async () => {
    seed()
    const code = await runCli(['focus', '--workspace', 'ws-1', '--baseline-commit', 'c1'], io(root))
    expect(code).toBe(2)
    expect(err.join('')).toMatch(/focus/)
  })

  it('an unknown decision → rc=3 (DecisionNotFoundError, focus exit-code parity)', async () => {
    seed()
    const code = await runCli(
      ['focus', 'no-such-decision', '--workspace', 'ws-1', '--baseline-commit', 'c1'],
      io(root),
    )
    expect(code).toBe(3)
  })

  it('runCli returns a Promise that resolves to the rc for the async focus path', async () => {
    const { decisionId } = seed()
    const result = runCli(['focus', decisionId, '--workspace', 'ws-1', '--baseline-commit', 'c1'], io(root))
    expect(typeof (result as Promise<number>).then).toBe('function') // it's a thenable
    await expect(Promise.resolve(result)).resolves.toBe(0)
  })

  it('serve-empty: no .track resolves → an unadopted-repo focus serves not-found (rc=3), never crashes', async () => {
    // A fresh dir with NO `.track` ancestor: the read group binds a nonexistent log, focus reads empty,
    // and an unknown decision over an empty log is DecisionNotFoundError → rc=3 (not a boot crash).
    const unadopted = mkdtempSync(join(tmpdir(), 'track-focus-unadopted-'))
    try {
      const code = await runCli(
        ['focus', 'any-decision', '--workspace', 'ws-1', '--baseline-commit', 'c1'],
        io(unadopted),
      )
      expect(code).toBe(3)
      expect(err.join('')).toMatch(/track init/) // the serve-empty stderr hint still fires
      expect(existsSync(join(unadopted, '.track'))).toBe(false) // reads never materialize a store
    } finally {
      rmSync(unadopted, { recursive: true, force: true })
    }
  })

  it('performs NO append — the event log is byte-identical after a render', async () => {
    const { decisionId } = seed()
    const before = readFileSync(eventsPath, 'utf8')
    await runCli(['focus', decisionId, '--workspace', 'ws-1', '--baseline-commit', 'c1'], io(root))
    const after = readFileSync(eventsPath, 'utf8')
    expect(after).toBe(before)
  })
})
