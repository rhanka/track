import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { canonicalize, materialize } from './canonical.js'
import { contentHashOf } from './frame.js'
import { readHead, writeHead } from './head.js'
import { withFileLock, type LockOptions } from './lock.js'
import type { CommandEvent, EventCore, Sha256, TrackEvent, Ulid } from './types.js'
import { validate } from './validate.js'

/**
 * Operational-only lock timeout override (`TRACK_LOCK_TIMEOUT_MS`). Lets a caller cap how long a
 * contended append waits before failing loud — used by tests and by anyone who prefers a fast fail
 * over the 10s default. It does NOT touch the frozen event contract (no event shape/hash/seq change),
 * only how long `withFileLock` blocks. An invalid/absent value falls back to the lock's own default.
 */
function lockOptionsFromEnv(): LockOptions {
  const raw = process.env['TRACK_LOCK_TIMEOUT_MS']
  if (raw === undefined) return {}
  const ms = Number(raw)
  return Number.isFinite(ms) && ms > 0 ? { timeoutMs: ms } : {}
}

/**
 * Append-only single-writer event store over `.track/events.jsonl` (SPEC §3, §4).
 * The store owns the integrity frame: it assigns per-aggregate `seq`, the positional
 * `prevHash`, and `contentHash`, and writes a command's events as one atomic batch.
 *
 * Fail-closed: `appendCommand` `validate`s the existing log before extending it, so a
 * tampered/reordered/truncated log cannot be silently grown.
 */
export class EventStore {
  constructor(private readonly filePath: string) {}

  /** All events in stream (append) order. Throws on a malformed (e.g. torn) line. */
  readAll(): TrackEvent[] {
    if (!existsSync(this.filePath)) return []
    const raw = readFileSync(this.filePath, 'utf8')
    const events: TrackEvent[] = []
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === undefined || line.trim().length === 0) continue
      try {
        events.push(JSON.parse(line) as TrackEvent)
      } catch {
        throw new Error(`EventStore: malformed event line ${i + 1} in ${this.filePath}`)
      }
    }
    return events
  }

  /**
   * Append one command's events atomically. A multi-event command (`inputs.length > 1`)
   * requires `opts.cmdId` and is tagged with `cmd:{i,n}`; a single-event command is
   * standalone (no `cmdId`). Refuses to extend a log that does not pass `validate`.
   *
   * Idempotency backstop (M3-channel): under the lock, after the existing log's integrity is proven (F3)
   * and before framing, an idempotency hook may dedup a concurrent retry — returning the ORIGINAL persisted
   * events and appending NOTHING. This is ATOMIC w.r.t. concurrent writers: a racing second writer that
   * bypassed the ingest-layer fast-path re-reads HERE and sees the first writer's events. The hook is
   * INJECTABLE via `opts.dedupe`; the DEFAULT (no hook) is `dedupByClientToken`, scoped by
   * `(clientToken, aggregateId)` — the store-neutral backstop for direct callers that have no workspace
   * (across workspaces aggregateIds always differ, so a token in V never suppresses a write in W). The
   * workspace-aware caller (ingest) injects a hook keyed on `(workspace, clientToken)`, which is stable
   * across a re-minted aggregateId (so a concurrent CREATE-retry — fresh aggregateId per attempt — dedups
   * to ONE event). A command with no token, or a token absent from the log, appends normally; the default
   * hook fails closed (throws) on a token reused across a PARTIAL aggregate overlap. See `dedupByClientToken`.
   */
  appendCommand(
    inputs: ReadonlyArray<CommandEvent>,
    opts: {
      cmdId?: Ulid
      /**
       * Optional under-lock idempotency hook (the ingest workspace-scoped path). Called AFTER the
       * existing-log integrity is proven (F3) and BEFORE framing, with the command's `inputs` and the
       * just-read `existing` log. Returns the persisted originals to dedup (append NOTHING, return them
       * verbatim), or `null` to append normally. DEFAULT (no hook) = `dedupByClientToken` — the
       * store-neutral `(clientToken, aggregateId)` backstop for direct callers that have no workspace.
       * A workspace-aware caller (ingest) injects a hook keyed on `(workspace, clientToken)`, which is
       * stable across a re-minted aggregateId (so a concurrent create-retry dedups to ONE event).
       */
      dedupe?: (inputs: ReadonlyArray<CommandEvent>, existing: readonly TrackEvent[]) => TrackEvent[] | null
      /**
       * Optional under-lock DOMAIN-LEGALITY recheck (demand-lifecycle Mode A, F2 semantic-race guard).
       * Called AFTER existing-log integrity is proven and AFTER the dedupe short-circuit (a true idempotent
       * retry is absorbed by `dedupe` and never rechecked), BEFORE framing, with the command's `inputs` and
       * the just-read `existing` log. It re-folds the existing log under the lock and re-asserts the demand
       * transition (+ duplicateOf containment); it MUST THROW (a DomainError) when the command is no longer
       * legal against the now-current state — catching the cross-actor race the per-aggregate lock does NOT
       * cover (two actors fold the same pre-lock state and append contradictory-but-individually-valid
       * events). SCOPED to the new Mode A commands only — existing append paths pass no hook (unchanged).
       */
      recheck?: (inputs: ReadonlyArray<CommandEvent>, existing: readonly TrackEvent[]) => void
    } = {},
  ): TrackEvent[] {
    if (inputs.length === 0) {
      throw new Error('EventStore.appendCommand: empty command (no events)')
    }
    const n = inputs.length
    const isBatch = n > 1
    if (isBatch && opts.cmdId === undefined) {
      throw new Error('EventStore.appendCommand: a multi-event command requires a cmdId')
    }

    // Serialize the read→validate→compute→append→writeHead critical section ACROSS processes. Without
    // it, two concurrent writers compute the same prevHash/seq and corrupt the single stream, which the
    // fail-closed guard below then turns into a permanent write-DoS for every future writer (see lock.ts).
    return withFileLock(this.filePath, () => {
      const existing = this.readAll()
      const before = existing.length

      // Existing-log integrity FIRST (F3) — proven BEFORE any success path, including the dedup
      // short-circuit. A duplicate must NEVER return rc=0 on a corrupt/tampered/truncated log: the
      // "original" events read back from a tampered log are not a trustworthy receipt. So every success
      // path first proves the existing log is sound; only then may the dedup early-return fire.
      const integrity = validate(existing, readHead(this.filePath))
      if (!integrity.ok) {
        const kinds = integrity.findings.map((f) => f.kind).join(', ')
        throw new Error(
          `EventStore.appendCommand: refusing to extend an invalid log ` +
            `(${integrity.findings.length} finding(s): ${kinds})`,
        )
      }

      // Under-lock idempotency recheck (atomic with the append) — the concurrent-retry backstop, run
      // only AFTER the existing log has proven sound. If this command carries a delivery token already
      // present in the just-read log for the SAME aggregate set, return the ORIGINAL persisted events and
      // append NOTHING. The lock makes this authoritative: a racing second writer that bypassed the ingest
      // fast-path re-reads HERE and sees the first writer's token. The store is WORKSPACE-BLIND by design —
      // workspace containment is the INGEST layer's load-bearing property; the (clientToken, aggregateId)
      // scope here assumes per-workspace aggregateId uniqueness (ULID minting + ingest containment), and
      // FAILS CLOSED on a token/aggregate anomaly (partial overlap → throw) rather than silently
      // suppressing. A tokenless command, or a token-absent log, falls through and appends normally. The
      // command's events are framed/hashed only AFTER this skip.
      const deduped = (opts.dedupe ?? ((i, e) => this.dedupByClientToken(i, e)))(inputs, existing)
      if (deduped !== null) return deduped

      // Under-lock DOMAIN-LEGALITY recheck (demand-lifecycle Mode A, F2). Runs ONLY for the new Mode A
      // commands (existing paths pass no hook), AFTER the dedupe short-circuit (so an idempotent retry is
      // absorbed, never rechecked), and re-asserts the demand transition against the NOW-current folded log.
      // Throws (DomainError) on a contradiction ⇒ a racing second writer that saw a stale pre-lock state is
      // rejected here rather than appending a contradictory event.
      if (opts.recheck !== undefined) opts.recheck(inputs, existing)

      let prevHash: Sha256 | null =
        existing.length > 0 ? existing[existing.length - 1]!.contentHash : null

      // Next per-aggregate seq = max(seq) + 1, aligned with validate's authority.
      const lastSeqByAggregate = new Map<string, number>()
      for (const e of existing) {
        lastSeqByAggregate.set(e.aggregateId, e.seq)
      }

      const events: TrackEvent[] = []
      inputs.forEach((input, i) => {
        const seq = (lastSeqByAggregate.get(input.aggregateId) ?? 0) + 1
        lastSeqByAggregate.set(input.aggregateId, seq)
        const core: EventCore = isBatch
          ? { ...input, cmdId: opts.cmdId!, cmd: { i, n } }
          : { ...input }
        // Materialize ONCE to an inert plain-data snapshot, then hash AND persist that same
        // snapshot — so a live payload (Proxy / getter / toJSON) cannot diverge between the two.
        const materialized = materialize(core) as EventCore
        const contentHash = contentHashOf(materialized)
        const event: TrackEvent = { ...materialized, seq, prevHash, contentHash }
        events.push(event)
        prevHash = contentHash
      })

      // Validate the FULL candidate stream (not just the existing prefix): the command itself
      // could introduce a cross-event violation (e.g. an aggregate-mismatch, a malformed batch).
      const candidate = validate([...existing, ...events])
      if (!candidate.ok) {
        const kinds = candidate.findings.map((f) => f.kind).join(', ')
        throw new Error(
          `EventStore.appendCommand: command would produce an invalid log ` +
            `(${candidate.findings.length} finding(s): ${kinds})`,
        )
      }

      this.appendAtomic(events)
      const expectedHead = {
        streamLength: existing.length + events.length,
        lastContentHash: events[events.length - 1]!.contentHash,
      }
      writeHead(this.filePath, expectedHead)

      // P0 AppendReceipt — the load-bearing guard. STILL UNDER THE LOCK, re-read the persisted log and
      // head and PROVE the write landed. This makes "rc=0 without persistence" structurally impossible:
      // a no-op `appendAtomic`, a short write, a wrong path, or a torn tail all surface as a THROW here
      // (CLI → rc=1), never a silent success. Only a verified receipt returns.
      this.verifyAppend(before, events, expectedHead)
      return events
    }, lockOptionsFromEnv())
  }

  /**
   * Under-lock delivery-idempotency recheck. Returns the EXACT persisted events for this command's
   * `clientToken` when the command is a true atomic-batch retry (dedup), `null` when it is a fresh write
   * (append normally), and THROWS fail-closed when a delivery token is reused across a logically distinct
   * aggregate set (partial overlap → would double-write).
   *
   * Decision rule (scoped by `(clientToken, aggregateId)`):
   *  - One delivery token per command. `inputAggregates` = the command's aggregateIds; `tokenAggregates` =
   *    the aggregateIds in `existing` that already carry this token. `presentInputs` = their intersection.
   *  - Case A (`presentInputs` empty): the token covers NONE of this command's aggregates — a fresh write,
   *    OR the load-bearing namespacing case (the token lives on OTHER aggregates/workspaces, whose
   *    aggregateIds always differ) → return `null` (append normally). MUST NOT throw.
   *  - Case B (`presentInputs` == `inputAggregates`, every input aggregate already carries the token): a
   *    true atomic-batch retry → dedup, returning EXACTLY the persisted events whose `aggregateId` is in
   *    `inputAggregates` AND `clientToken === token`, in stream (persisted) order — the original batch's
   *    events (NOT every event carrying the token). Because `appendAtomic` is all-or-nothing, a genuine
   *    retry of one batch always satisfies this set-equality, so callers/idempotency get stable ids.
   *  - Case C (`presentInputs` non-empty but != `inputAggregates`): a genuine partial overlap — a producer
   *    reused a delivery token across logically distinct commands; appending would double-write the present
   *    aggregates → THROW fail-closed (never a silent superset return or a cross-workspace disclosure).
   *
   * The store is WORKSPACE-BLIND by design (F1): workspace containment is the INGEST layer's load-bearing
   * property; the `(clientToken, aggregateId)` scope here assumes per-workspace aggregateId uniqueness
   * (ULID minting + ingest containment) and fails closed (Case C) on any token/aggregate anomaly rather
   * than silently suppressing. It deliberately does NOT compare event bodies/`contentHash` (F2): a retry
   * legitimately RE-MINTS a fresh `id`/`at` per attempt, so `contentHash` differs across a legitimate
   * retry — a body-digest check here would reject the very concurrent-retry this backstop exists to absorb.
   * Body-digest "409 on same key / different body" conflict detection (over the stable, pre-mint WorkEvent
   * payload) is the GATEWAY/INGEST layer's contract, deferred to M3-HTTP — never enforced here.
   */
  private dedupByClientToken(
    inputs: ReadonlyArray<CommandEvent>,
    existing: readonly TrackEvent[],
  ): TrackEvent[] | null {
    // One delivery token per command (emitBatch stamps the same token on the whole batch). If the inputs
    // carry no single shared token, there is nothing to dedup.
    const tokens = new Set(inputs.map((i) => i.clientToken))
    if (tokens.size !== 1) return null
    const token = inputs[0]!.clientToken
    if (token === undefined) return null

    // Persisted events carrying this token, grouped/ordered by aggregateId, plus the set of those
    // aggregateIds (`tokenAggregates`).
    const persistedByAggregate = new Map<string, TrackEvent[]>()
    for (const e of existing) {
      if (e.clientToken !== token) continue
      const group = persistedByAggregate.get(e.aggregateId)
      if (group === undefined) persistedByAggregate.set(e.aggregateId, [e])
      else group.push(e)
    }

    const inputAggregates = new Set(inputs.map((i) => i.aggregateId))
    let presentCount = 0
    for (const aggregateId of inputAggregates) {
      if (persistedByAggregate.has(aggregateId)) presentCount += 1
    }

    // Case A — the token covers NONE of this command's aggregates: a fresh write, or the namespacing case
    // (the token lives on OTHER aggregates/workspaces). Append normally. MUST NOT throw.
    if (presentCount === 0) return null

    // Case C — partial overlap: some input aggregates carry the token, some do not. A delivery token reused
    // across a logically distinct aggregate set; appending would double-write the present aggregates.
    if (presentCount !== inputAggregates.size) {
      throw new Error(
        `EventStore.appendCommand: delivery clientToken ${token} reused across a different aggregate set ` +
          `(partial overlap) — refusing to append (would double-write)`,
      )
    }

    // Case B — every input aggregate already carries the token: a true atomic-batch retry. Return EXACTLY
    // the persisted events for this command's aggregates (clientToken === token), in stream (persisted)
    // order — the original batch's events, never the full token superset.
    const original: TrackEvent[] = []
    for (const e of existing) {
      if (e.clientToken === token && inputAggregates.has(e.aggregateId)) original.push(e)
    }
    return original
  }

  /**
   * Post-write verification (under the append lock). Re-reads the persisted log + head and asserts:
   *  (1) the log grew by exactly `events.length` (length); (2) the persisted suffix matches the
   *  generated events by `id` + `contentHash` (identity); (3) the head's `streamLength` /
   *  `lastContentHash` match the write; (4) the full persisted stream still `validate`s (integrity).
   * Any mismatch throws `append verification failed for <path> …` — the receipt the caller can trust.
   */
  private verifyAppend(
    before: number,
    events: ReadonlyArray<TrackEvent>,
    expectedHead: { streamLength: number; lastContentHash: Sha256 },
  ): void {
    const fail = (reason: string): never => {
      throw new Error(`append verification failed for ${this.filePath}: ${reason}`)
    }

    const after = this.readAll()
    if (after.length !== before + events.length) {
      fail(`length ${after.length} != before ${before} + ${events.length} (write did not persist)`)
    }

    const suffix = after.slice(before)
    for (let i = 0; i < events.length; i++) {
      const persisted = suffix[i]
      const expected = events[i]!
      if (persisted === undefined || persisted.id !== expected.id || persisted.contentHash !== expected.contentHash) {
        fail(
          `persisted suffix[${i}] (id=${persisted?.id ?? '<none>'}, hash=${persisted?.contentHash ?? '<none>'}) ` +
            `!= generated (id=${expected.id}, hash=${expected.contentHash})`,
        )
      }
    }

    const head = readHead(this.filePath)
    if (
      head === null ||
      head.streamLength !== expectedHead.streamLength ||
      head.lastContentHash !== expectedHead.lastContentHash
    ) {
      fail(
        `head mismatch (persisted ${JSON.stringify(head)} != expected ${JSON.stringify(expectedHead)})`,
      )
    }

    const integrity = validate(after, head)
    if (!integrity.ok) {
      const kinds = integrity.findings.map((f) => f.kind).join(', ')
      fail(`persisted stream is invalid (${integrity.findings.length} finding(s): ${kinds})`)
    }
  }

  /**
   * Append all of a command's lines in one fsync'd write. Each line is the event's `canonicalize`
   * form — the SAME serialization used for `contentHash`, so persisted bytes can never diverge
   * from the hashed bytes (immune to prototype pollution / live values). `writeSync` may
   * short-write, so we loop until every byte is flushed. This makes a normal append durable; it
   * does not make a mid-write *crash* atomic — a torn trailing line is reported by
   * `validate`/`readAll` (fail-closed), not silently skipped.
   */
  private appendAtomic(events: ReadonlyArray<TrackEvent>): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const buffer = Buffer.from(events.map((e) => canonicalize(e)).join('\n') + '\n', 'utf8')
    const fd = openSync(this.filePath, 'a')
    try {
      let offset = 0
      while (offset < buffer.length) {
        offset += writeSync(fd, buffer, offset, buffer.length - offset)
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}
