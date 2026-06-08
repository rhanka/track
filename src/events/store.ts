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
import { withFileLock } from './lock.js'
import type { CommandEvent, EventCore, Sha256, TrackEvent, Ulid } from './types.js'
import { validate } from './validate.js'

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
   */
  appendCommand(
    inputs: ReadonlyArray<CommandEvent>,
    opts: { cmdId?: Ulid } = {},
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
      const integrity = validate(existing, readHead(this.filePath))
      if (!integrity.ok) {
        const kinds = integrity.findings.map((f) => f.kind).join(', ')
        throw new Error(
          `EventStore.appendCommand: refusing to extend an invalid log ` +
            `(${integrity.findings.length} finding(s): ${kinds})`,
        )
      }

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
      writeHead(this.filePath, {
        streamLength: existing.length + events.length,
        lastContentHash: events[events.length - 1]!.contentHash,
      })
      return events
    })
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
