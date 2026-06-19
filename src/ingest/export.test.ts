// `./ingest` curated submit barrel — the in-process SUBMIT seam for the M5 canevas host (architect-ratified
// "submit = A": the host imports track in-process and carries auth via the IngestContext; the HTTP gateway —
// M3 — stays deferred). These tests pin the barrel's named export surface and an END-TO-END in-process submit
// through ONLY the barrel's exports, and assert the build emits the subpath's compiled entrypoint so the
// `@sentropic/track/ingest` package export resolves at runtime.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// IMPORTANT: import ONLY from the curated barrel — these are exactly the names the in-process host gets.
import * as Ingest from './index.js'
import {
  BINDING_AUTH,
  INGEST_CONTRACT_VERSION,
  IngestError,
  ingest,
  isBindingAuth,
  type IngestContext,
  type IngestResult,
  type WorkEvent,
  type WorkEventKind,
} from './index.js'

// The EventStore is NOT part of the submit barrel (the host wires its own store via the core barrel `.`);
// the e2e test imports it directly from the core module to drive a temp store.
import { EventStore } from '../events/store.js'
import type { Provenance } from '../events/types.js'

const here = fileURLToPath(new URL('.', import.meta.url))

let dir: string
let n = 0
const freshStore = (): EventStore => new EventStore(join(dir, `s${++n}`, '.track', 'events.jsonl'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'track-ingest-export-'))
  n = 0
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('./ingest barrel — the submit-facing surface', () => {
  it('exports exactly the documented submit surface (named values + types) and nothing extra', () => {
    // The runtime VALUE exports the host needs: the function, the contract version, the error, the
    // binding-auth pre-check (predicate + decoupled frozen copy).
    expect(typeof ingest).toBe('function')
    expect(INGEST_CONTRACT_VERSION).toBe('1.2.0')
    expect(typeof IngestError).toBe('function')

    // The pre-check PREDICATE — the host's "does my channel auth admit binding writes?" question.
    expect(typeof isBindingAuth).toBe('function')
    expect(isBindingAuth('local-user')).toBe(true)
    expect(isBindingAuth('signed')).toBe(true)
    expect(isBindingAuth('unauthenticated')).toBe(false)

    // The DECOUPLED frozen copy of the admit-set — a frozen array, NOT the gate's live Set. Same members.
    expect(Array.isArray(BINDING_AUTH)).toBe(true)
    expect(Object.isFrozen(BINDING_AUTH)).toBe(true)
    expect([...BINDING_AUTH].sort()).toEqual(['local-user', 'signed'])

    // The barrel exposes ONLY the curated runtime value names (types erase at runtime, so they do not
    // appear here): ingest, isBindingAuth, BINDING_AUTH, INGEST_CONTRACT_VERSION, IngestError. A
    // deliberate, documented contract — not `export *`.
    expect(new Set(Object.keys(Ingest))).toEqual(
      new Set(['ingest', 'isBindingAuth', 'INGEST_CONTRACT_VERSION', 'IngestError', 'BINDING_AUTH']),
    )
  })

  it('the curated types are usable to construct a submit (compile-time surface)', () => {
    // This is a TYPE-level assertion: the names below must resolve as types from the barrel, or tsc fails.
    const ev: WorkEvent = { v: 1, kind: 'item.create', payload: { kind: 'feature', title: 'T', workspace: 'ws' } }
    const kind: WorkEventKind = 'decision.outcome'
    const prov: Provenance = { transport: 'import', proposed: false, auth: 'local-user' }
    const ctx: IngestContext = { by: 'human:host', workspace: 'ws', prov }
    const result: IngestResult = ingest([ev], ctx, freshStore())
    expect(kind).toBe('decision.outcome')
    expect(result.count).toBe(1)
  })
})

describe('./ingest barrel — END-TO-END in-process submit through ONLY the barrel exports', () => {
  it('an authenticated host submits a binding stream (item.realize→done, decision.outcome) and reads the receipt', () => {
    const store = freshStore()
    // The host carries auth via the IngestContext (WHO/trust from the context, never the event).
    const prov: Provenance = { transport: 'import', proposed: false, auth: 'local-user' }
    const ctx: IngestContext = { by: 'human:host', workspace: 'ws', prov }

    // Construct a real canevas submit: create an item + decision, realize the item done, settle the decision.
    const events: WorkEvent[] = [
      { v: 1, kind: 'item.create', payload: { kind: 'feature', title: 'Canevas card', workspace: 'ws' } },
    ]
    const created = ingest(events, ctx, store)
    expect(created.count).toBe(1)
    const itemId = created.ids[0]
    expect(typeof itemId).toBe('string')

    const decBatch: WorkEvent[] = [
      {
        v: 1,
        kind: 'decision.create',
        payload: {
          decisionKind: 'orientation',
          title: 'Ship it',
          workspace: 'ws',
          targets: [itemId],
          dossier: { context: '', options: [], qa: [] },
        },
      },
    ]
    const decRes = ingest(decBatch, ctx, store)
    const decisionId = decRes.ids[0]
    expect(typeof decisionId).toBe('string')

    // Binding settling writes — allowed because the channel is authenticated (auth ∈ BINDING_AUTH).
    const settle: WorkEvent[] = [
      { v: 1, kind: 'item.realize', payload: { itemId, to: 'in-progress' } },
      { v: 1, kind: 'item.realize', payload: { itemId, to: 'done' } },
      { v: 1, kind: 'decision.outcome', payload: { decisionId, to: 'go' } },
    ]
    const settleRes = ingest(settle, ctx, store)
    // Receipt SHAPE: ids array (null for non-creating kinds) in input order + a count.
    expect(settleRes).toEqual({ ids: [null, null, null], count: 3 })

    // The events PERSISTED to the store (the submit actually wrote through the seam).
    const persisted = store.readAll()
    const types = persisted.map((e) => e.type)
    expect(types).toContain('item.created')
    expect(types).toContain('decision.created')
    expect(types).toContain('decision.outcome')
    // The item reached terminal `done` (two realization transitions: in-progress, then done).
    const realizeEvents = persisted.filter((e) => e.type === 'realization.transition')
    expect(realizeEvents.length).toBe(2)
  })

  it('an UNAUTHENTICATED context is rejected at the binding gate (IngestError) — fail-closed', () => {
    const store = freshStore()
    const authedProv: Provenance = { transport: 'import', proposed: false, auth: 'local-user' }
    const authed: IngestContext = { by: 'human:host', workspace: 'ws', prov: authedProv }
    // Create an item with an AUTHENTICATED channel first (create is non-binding, but we use authed to set up).
    const itemId = ingest(
      [{ v: 1, kind: 'item.create', payload: { kind: 'feature', title: 'T', workspace: 'ws' } }],
      authed,
      store,
    ).ids[0]

    // Now an UNAUTHENTICATED channel attempts a BINDING write (realize→done) — must throw IngestError.
    const unauthProv: Provenance = { transport: 'import', proposed: false, auth: 'unauthenticated' }
    const unauth: IngestContext = { by: 'agent:x', workspace: 'ws', prov: unauthProv }
    expect(() =>
      ingest([{ v: 1, kind: 'item.realize', payload: { itemId, to: 'done' } }], unauth, store),
    ).toThrow(IngestError)
  })

  it('SECURITY: mutating the exported binding-auth surface CANNOT bypass the gate (decoupled)', () => {
    // Pre-fix this was RED: the barrel re-exported the gate's LIVE Set, so a consumer could
    // `BINDING_AUTH.add('unauthenticated')` and slip an unauthenticated binding write past the gate.
    // The exported surface is now decoupled (predicate over a private Set + a FROZEN copy), so the
    // attack below is a no-op/throws and the gate is unaffected.
    const store = freshStore()
    const authed: IngestContext = {
      by: 'human:host',
      workspace: 'ws',
      prov: { transport: 'import', proposed: false, auth: 'local-user' },
    }
    const itemId = ingest(
      [{ v: 1, kind: 'item.create', payload: { kind: 'feature', title: 'T', workspace: 'ws' } }],
      authed,
      store,
    ).ids[0] as string
    const decisionId = ingest(
      [
        {
          v: 1,
          kind: 'decision.create',
          payload: {
            decisionKind: 'orientation',
            title: 'D',
            workspace: 'ws',
            targets: [itemId],
            dossier: { context: '', options: [], qa: [] },
          },
        },
      ],
      authed,
      store,
    ).ids[0] as string

    // ATTACK 1: the frozen array cannot be mutated (push throws in strict ESM / is a no-op).
    expect(() => (BINDING_AUTH as unknown as string[]).push('unauthenticated')).toThrow()
    // ATTACK 2: if a consumer mistakes it for a Set facade, `.add` simply does not exist (no bypass).
    expect((BINDING_AUTH as unknown as { add?: unknown }).add).toBeUndefined()
    // The pre-check predicate still reports the unchanged admit-set.
    expect(isBindingAuth('unauthenticated')).toBe(false)

    // The GATE is unaffected: an unauthenticated BINDING write (decision.outcome) STILL throws IngestError.
    const unauth: IngestContext = {
      by: 'agent:x',
      workspace: 'ws',
      prov: { transport: 'import', proposed: false, auth: 'unauthenticated' },
    }
    expect(() =>
      ingest([{ v: 1, kind: 'decision.outcome', payload: { decisionId, to: 'go' } }], unauth, store),
    ).toThrow(IngestError)
  })
})

describe('./ingest package export — the compiled subpath resolves at runtime', () => {
  it('the build emits dist/ingest/index.js and it is importable with the named submit surface', () => {
    const repoRoot = join(here, '..', '..')
    // Build emits the curated barrel's compiled entrypoint (the file `@sentropic/track/ingest` maps to).
    execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: repoRoot, stdio: 'pipe' })
    const distEntry = join(repoRoot, 'dist', 'ingest', 'index.js')
    expect(existsSync(distEntry)).toBe(true)
  }, 120_000)

  it('the compiled barrel re-exports the named submit values (runtime import of the emitted file)', async () => {
    const repoRoot = join(here, '..', '..')
    const distEntry = join(repoRoot, 'dist', 'ingest', 'index.js')
    if (!existsSync(distEntry)) execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: repoRoot, stdio: 'pipe' })
    const mod = (await import(pathToFileURL(distEntry).href)) as Record<string, unknown>
    expect(typeof mod['ingest']).toBe('function')
    expect(mod['INGEST_CONTRACT_VERSION']).toBe('1.2.0')
    expect(typeof mod['IngestError']).toBe('function')
    expect(typeof mod['isBindingAuth']).toBe('function')
    expect(Array.isArray(mod['BINDING_AUTH'])).toBe(true)
    expect(Object.isFrozen(mod['BINDING_AUTH'])).toBe(true)
  }, 120_000)
})
