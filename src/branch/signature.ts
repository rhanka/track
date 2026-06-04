// Lot v2.0 (review F1) — structural freshness signature for a BRANCH.md.
//
// Freshness must answer "is the track sidecar current with this BRANCH.md?" WITHOUT false-staling
// on edits track does not reconcile. importBranch only ever updates per-lot `done` and per-UAT
// `passed` (keyed by slug); titles/body/statements are create-only, and prose + lot order are
// ignored entirely. So the freshness signature hashes EXACTLY that reconciled projection — sorted
// by slug so reordering is invariant. Any change to reconciled structure flips the hash
// (fail-closed); a prose/title/reorder-only edit leaves it unchanged (no false-stale).
//
// Used by BOTH importBranch (to stamp `branch.imported.structureHash`) and TrackReader.freshness
// (to compare) — same function, so they cannot drift. Branch identity is carried by the locator,
// so it is intentionally NOT in the signature (keeps it fileSlug-independent for the reader).

import { computeHash } from '../events/canonical.js'
import { parseBranch } from './parse.js'

const byKey = <T extends Record<K, string>, K extends string>(k: K) => (a: T, b: T): number =>
  a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0

/**
 * @param branchSlug RESOLVED import identity. importBranch passes its fileSlug-aware
 *   `parsed.branchSlug` so the stamp reflects the real sourceKeys. The reader omits it → derives
 *   from the content's `BR-NN` heading only. They agree whenever the heading carries a BR id
 *   (the normal case); a headingless BRANCH.md imported with an explicit fileSlug therefore reads
 *   conservatively STALE (fail-closed — the reader cannot know the fileSlug, so it never declares
 *   such a branch fresh). Real sentropic BRANCH.md files always carry the heading.
 */
export function branchSignature(content: string, branchSlug?: string): string {
  const parsed = parseBranch(content)
  const slug = branchSlug ?? parsed.branchSlug
  const lots = parsed.lots
    .map((lot) => ({
      lotSlug: lot.lotSlug,
      done: lot.done,
      uat: lot.uat
        .map((u) => ({ uatSlug: u.uatSlug, passed: u.passed }))
        .sort(byKey('uatSlug')),
    }))
    .sort(byKey('lotSlug'))
  // `branchSlug` is part of import IDENTITY (feature + lot sourceKeys derive from it — track.ts),
  // so a same-locator re-point to a different BR id with identical lots must read STALE, never
  // false-fresh.
  return computeHash({ branchSlug: slug, lots })
}
