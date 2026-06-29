import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { EventStore } from '../events/store.js'
import type { CliIO } from './index.js'

/**
 * `track events-contains --base <log> --candidate <log> [--format json|text]` (DESIGN Lot B, B0b).
 *
 * A PURE, git-free, store-free containment primitive. It reads two EXPLICIT `.track` event logs by path,
 * extracts each event's STABLE ULID `id`, and reports the ids present in `--base` but ABSENT from
 * `--candidate`. It is the single shared primitive behind the B0 merge gate (the
 * skills/branch-lifecycle CI wrapper) and any B2 loss detector — there is no separate detector.
 *
 * Semantics (the load-bearing rc contract a CI gate keys on):
 *  - rc=0 ⇔ candidate ⊇ base: every base event id is present (no loss).
 *  - rc=1 ⇔ at least one base event id is MISSING from candidate (loss detected) — the missing ids are
 *    listed (text) / returned (json). This is the precise gate the squash-vs-merge-commit proxy is NOT:
 *    it is decided on the actual id sets, with no false positive (ULID ids are stable + the log is
 *    append-only, so the union of event sets is well defined).
 *  - rc=2 ⇔ cannot evaluate: a bad/missing flag, a log file that does not exist, or an unreadable
 *    (malformed) log. Kept DISTINCT from rc=1 so the wrapper can tell a real LOSS from a SETUP error,
 *    and so a typo'd `--base` can never read as a vacuous PASS.
 *
 * Containment is over the event `id` (NOT `contentHash`): the id is the durable identity that survives a
 * RE-SEAL (re-chaining recomputes `prevHash`/`seq`/`contentHash` but never the `id`), so the gate stays
 * correct across a re-sealed merge. It deliberately does NOT `validate`: a union-merged candidate has a
 * broken positional chain yet still enumerates every event, so containment stays computable on a merged
 * tail — exactly the case this gate must judge.
 */
export function cmdEventsContains(args: string[], io: CliIO): number {
  let base: string | undefined
  let candidate: string | undefined
  let format = 'text'
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--base') base = args[++i]
    else if (a === '--candidate') candidate = args[++i]
    else if (a === '--format') format = args[++i] ?? 'text'
  }

  if (base === undefined || candidate === undefined) {
    io.err('usage: track events-contains --base <log> --candidate <log> [--format json|text]\n')
    return 2
  }
  if (format !== 'json' && format !== 'text') {
    io.err(`track events-contains: --format must be one of: json|text (got "${format}")\n`)
    return 2
  }

  const basePath = isAbsolute(base) ? base : resolve(io.cwd, base)
  const candPath = isAbsolute(candidate) ? candidate : resolve(io.cwd, candidate)
  for (const [label, p] of [
    ['--base', basePath],
    ['--candidate', candPath],
  ] as const) {
    if (!existsSync(p)) {
      io.err(`track events-contains: ${label} log not found: ${p}\n`)
      return 2
    }
  }

  let baseIds: Set<string>
  let candIds: Set<string>
  try {
    baseIds = idsOf(basePath)
    candIds = idsOf(candPath)
  } catch (error) {
    io.err(`track events-contains: cannot read log (${error instanceof Error ? error.message : String(error)})\n`)
    return 2
  }

  // A base with 0 events makes containment VACUOUSLY true (rc=0). That is correct (nothing to lose) but is
  // also the shape of a setup mistake (wrong path, empty branch log), so warn loudly without failing.
  if (baseIds.size === 0) {
    io.err('track events-contains: WARNING — --base has 0 events; containment is vacuously satisfied (check the path)\n')
  }

  const missingIds = [...baseIds].filter((id) => !candIds.has(id)).sort()
  const contained = missingIds.length === 0

  if (format === 'json') {
    io.out(
      `${JSON.stringify(
        {
          base: basePath,
          candidate: candPath,
          baseCount: baseIds.size,
          candidateCount: candIds.size,
          missingIds,
          contained,
        },
        null,
        2,
      )}\n`,
    )
  } else if (contained) {
    io.out(`OK: candidate contains all ${baseIds.size} base event id(s)\n`)
  } else {
    io.out(`LOSS: ${missingIds.length} of ${baseIds.size} base event id(s) missing from candidate\n`)
    for (const id of missingIds) io.out(`${id}\n`)
  }

  return contained ? 0 : 1
}

/** The set of event `id`s in a `.track` log (read-only; never validates the integrity chain). */
function idsOf(path: string): Set<string> {
  const ids = new Set<string>()
  for (const e of new EventStore(path).readAll()) ids.add(e.id)
  return ids
}
