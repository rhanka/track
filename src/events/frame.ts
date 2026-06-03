import { computeHash } from './canonical.js'
import type { EventCore, Sha256, TrackEvent } from './types.js'

/**
 * contentHash domain = the `EventCore` (the event minus its integrity frame
 * `{seq, prevHash, contentHash}`), faithful to h2a `journal.ts` `stripFrame()`.
 * canonicalize() drops `undefined` keys and sorts keys, so an absent `cmdId`/`cmd`
 * does not change the hash.
 */
export function contentHashOf(core: EventCore): Sha256 {
  return computeHash(core) as Sha256
}

/** Recover the hash domain from a persisted event (drops the integrity frame). */
export function stripFrame(event: TrackEvent): EventCore {
  const { seq: _seq, prevHash: _prevHash, contentHash: _contentHash, ...core } = event
  void _seq
  void _prevHash
  void _contentHash
  return core
}
