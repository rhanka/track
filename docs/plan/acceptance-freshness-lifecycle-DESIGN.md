# Acceptance-Freshness Lifecycle — DESIGN (multi-worktree / merge re-staling)

Status: DRAFT for pair-review (Codex + Opus). SPEC/DESIGN only — no source touched.
Owner: track conductor. Surfacing lane: sentropic-chat (provided framing + the 38c repro; the build is track's to decide).
Grounded against: track `0.13.1`, READ contract `1.9.0`, INGEST contract `1.1.0`.

---

## 0. TL;DR

The acceptance freshness rule compares a recorded run's `commit` against a **single, global-HEAD**
`baselineCommit` by **literal string equality** (`src/accept/status.ts:25`). Any merge that moves
main's HEAD therefore re-stales **every** pinned acceptance whose run was recorded at the prior HEAD —
even items the merge does not touch. Accepting a done+merged feature becomes a treadmill ("tapis roulant").

Recommendation: **both (a) and (b)**, layered.
- **(a) change-set-anchored freshness** fixes the *semantics* so an unrelated merge no longer stales an
  item. track must start **recording the realization commit** (an additive optional payload field on
  `realization.transition`) and **expose** an item-anchored freshness; the **git ancestry/merge-base
  judgement stays OUT of track** (track is git-agnostic, record-only) — the caller/skill computes it.
- **(b) consolidation at branch-close** gives the **merge-time hook** + the **branches/worktrees skill**.
  A new APPEND-ONLY verb re-anchors realized+accepted items on the **merge commit** by appending events
  (never mutating), and "GC the stale-by-unrelated-merge" is a **compensating/annotating event + a
  read-filter**, never a deletion. The skill auto-reconciles the chat lane's 2 items.

Both are **additive** to the frozen contract: new optional payload field(s) + at most one new event kind;
every existing event hashes byte-identically. INGEST minor bump, READ minor bump.

---

## 1. Root cause

### 1.1 The rule
`src/accept/status.ts`:

```ts
// criterionStatus(state, criterionId, baselineCommit)
if (evidence.some((e) => e.latestRun!.commit !== baselineCommit)) return 'stale' // (4) not at baseline
return 'pass'
```

`baselineCommit` is a **single scalar** threaded down from `acceptanceStatus` → `criterionStatus`. The
freshness predicate is `run.commit === baselineCommit`, an **exact string compare** with **no notion of
ancestry, of the item's own change-set, or of which files the run actually exercised**. A run is "fresh"
**iff it was recorded at exactly the commit the reader names as the baseline**.

### 1.2 Where `baselineCommit` comes from
At the CLI boundary (`src/cli/index.ts`):
- `resolveCommit(cwd, undefined)` → `gitHead(cwd)` = `git rev-parse HEAD` (the **global HEAD of the
  current worktree's checked-out branch**, normally main).
- `resolveCommit(cwd, "HEAD"|<ref>|<short-sha>)` → `git rev-parse --verify <c>^{commit}` → the full SHA.

So in every normal read (`report`, `query`, `status`, `workspace-activity`, `scope validate`, `canevas`),
`baselineCommit` **is the global HEAD SHA**. There is exactly ONE baseline for the whole backlog, and it
**moves every time main's HEAD moves**.

### 1.3 The treadmill
An item's acceptance run is recorded at the commit that was HEAD *when the item was finished* (call it
`C_run`). It reads `pass` only while `HEAD === C_run`. The next merge to main (PR #316, #295 — wholly
unrelated to item 38c) advances `HEAD` to `C_merge ≠ C_run`. On the very next read, `38c`'s run.commit
(`C_run`) `!== baselineCommit` (`C_merge`) ⇒ **stale**. The item was never re-touched; nothing about *its*
change-set changed; yet it falls out of `accepted`. To get it back to `pass` you must re-run its tests at
the new HEAD — and the *next* unrelated merge stales it again. Treadmill confirmed by the 38c repro.

This is sharpened by **multi-worktree** (WP4): several lanes share one `.track` log but check out different
HEADs. "The baseline" is whichever worktree's HEAD the reader runs at — so the same log yields different
stale/pass verdicts per worktree, and there is no single commit at which all merged-and-accepted items are
simultaneously fresh.

### 1.4 Why 0.10.8 did NOT fix this
0.10.8 (`9b43b18`, "resolve `--commit HEAD`/refs at the CLI boundary") fixed a **different** bug: an
**explicit** `--commit HEAD` literal reached the compare verbatim (`'HEAD' !== <40-char-sha>`), so even a
run recorded *at the same commit* read stale. The fix **normalizes both ends to the same resolved SHA** so
they can be equal. It deliberately left "status.ts literal compare untouched" (per its own commit body).

That is the point: 0.10.8 made the **two ends agree on the SAME string** — but that string is **still the
single moving global HEAD**. It cured a string-mismatch footgun; it did nothing about the *lifecycle*
problem that the baseline is a moving target an unrelated merge advances. The literal-equality-against-
moving-HEAD semantics is exactly the hole this design addresses.

---

## 2. Option (a) — change-set-anchored freshness

### 2.1 What "the item's realization change-set / commit" means
Concretely: **the commit at which the item's work landed** — the commit the agent set `item.realize → done`
*against* (its realization commit), or, after merge, the merge commit that brought that work onto main.
Freshness should mean **"the accepting run was taken at a commit that includes the item's realization and is
not behind it"**, NOT "the run was taken at exactly the current global HEAD". An unrelated later merge
advances HEAD but does **not** invalidate a run taken at-or-after the item's own realization — so it must
not stale the item.

### 2.2 Does track record the realization commit today? — **NO**
Confirmed across the source:
- `item.realize` (WorkEvent) → `Track.setRealization(itemId, to)` → emits `realization.transition` with
  payload **`{ to }`** only (`src/track.ts:285-296`). The internal no-go path adds `{ to:'rejected',
  cause:{decisionId} }`. **No commit is ever captured.**
- The fold (`src/state/fold.ts:197`) sets `item.realization = payload.to`. `ItemState`/`Realization`
  (`src/model/item.ts`) carry **no** realization-commit field.
- The only place a commit is recorded in the whole model is `acceptance.run.commit` (`TestRun.commit`,
  `src/model/acceptance.ts`) — i.e. the run side, never the realize side.

So option (a) **requires an additive record**: track must capture the commit at realization time.

### 2.3 The additive field/event needed
Add an **optional** `commit?: string` to the `item.realize` WorkEvent payload, persisted onto the existing
`realization.transition` event and folded into a new optional `ItemState.realizedCommit?` (set when
`to ∈ {done}`; the caller supplies it from `git rev-parse HEAD` at realize time, exactly as `accept run`
already supplies `--commit`). This is the symmetric twin of `acceptance.run.commit`.

- **Additive / hash-safe**: `canonicalize` drops `undefined`, so every pre-existing `realization.transition`
  event hashes byte-identically; old producers omit it; the fold treats absent as "no anchor".
- **No new event kind needed for (a)** — it rides the existing `realization.transition` event with an extra
  optional payload field (cheapest possible contract delta). (A separate `realization.anchored` event is an
  alternative if we want to re-anchor *without* a realization transition — see §3, where (b) needs exactly
  that for the merge-commit re-anchor.)

### 2.4 What track exposes vs what the caller computes — the git-agnostic split
**Track is record-only and holds no git** (`TrackReader` "Holds NO `git` and only reads the event file/head
via `fs`"). track MUST NOT compute ancestry / merge-base — that needs the repo's commit graph, which lives
outside the contract. So the split is:

- **track exposes** (pure, over the folded log): per criterion/item, the **run commit(s)** and the **item's
  realization commit (the anchor)** — two opaque SHA strings — plus a freshness *classification track CAN
  make purely*:
  - `unknown` / `fail` / `waived` as today;
  - a new **purely-decidable** rung: **`fresh-at-anchor`** = the run's commit **equals the item's recorded
    realization/anchor commit** (string equality track already does — just against the *item's own anchor*
    instead of the global HEAD). This alone kills the treadmill for the common case (run taken at the
    realize commit, never re-stales on unrelated merges) **without any git knowledge in track**.
  - When run.commit ≠ anchor and ≠ baseline, track returns a new **`needs-ancestry`** verdict (it cannot
    decide alone) carrying both SHAs, deferring the merge-base/ancestry judgement to the caller.
- **the caller/skill computes** (has git): given track's two SHAs, run `git merge-base --is-ancestor
  <run.commit> <anchor>` (and/or the reverse) to decide whether the run is at-or-after the realization. The
  skill folds that git verdict back into a final accepted/stale call, OR records it as a consolidation event
  (§3) so the next read is purely-decidable.

This keeps the **moving global HEAD out of the freshness predicate entirely**: freshness is measured against
the *item's anchor*, not the backlog's HEAD. `baselineCommit` stays as the parameter name for back-compat,
but option (a) changes its *role* from "the equality target" to "the fallback target only when an item has no
anchor recorded" (pre-(a) items, decisions, manual evidence).

### 2.5 Read-projection vs new-event split
- **New event data**: the `commit?` on `realization.transition` (one optional payload field). Persisted,
  hash-covered, additive.
- **Pure read-projection** (no new event): `criterionStatus`/`acceptanceStatus` gain an optional
  `anchorCommit` (the item's `realizedCommit`) and prefer it over `baselineCommit` when present. The new
  `fresh-at-anchor` / `needs-ancestry` rungs are computed, never stored.

### 2.6 Pros / cons
**Pros**
- Fixes the *semantics* at the root: unrelated merges stop staling items whose anchor is unchanged.
- Minimal contract delta (one optional field, no new kind).
- Keeps track git-agnostic — the ancestry call is the caller's, cleanly.
- Symmetric with the existing `acceptance.run.commit` model; easy to reason about.

**Cons**
- Only items realized *after* (a) ships carry an anchor; pre-(a) done items have none → they fall back to the
  old HEAD-equality (still treadmilled) until consolidation (§3) anchors them. So (a) alone does not heal the
  *existing* backlog — it stops *new* staling. (This is the core argument for also doing (b).)
- `fresh-at-anchor` is exact-equality only; the genuinely-ancestral case (run at a *descendant* of the
  anchor) needs the caller's git call — a two-step dance unless consolidated.
- An item with *no* realization commit yet (in-progress, accepted-early) has no anchor to measure against.

---

## 3. Option (b) — consolidation at branch-close

### 3.1 The new APPEND-ONLY verb
`track consolidate` (alias `track branch-close`) — a write that, given the branch's **merge commit** and the
set of realized+accepted items on the branch, **appends** re-anchoring events. It NEVER mutates or deletes;
every effect is a new event at the next seq.

It appends, per affected item, one of:
- a **`realization.anchored`** event (NEW additive kind) carrying `{ itemId, commit: <mergeCommit> }` — a
  pure anchor update that re-points the item's `realizedCommit` to the merge commit **without** a realization
  transition (the item is already `done`; `done` is terminal so we cannot re-emit `realization.transition`).
  This is the merge-time twin of §2.3's field: §2.3 anchors at realize time; this re-anchors at merge time.
- and/or an **`acceptance.consolidated`** annotation (could be the same kind with a `consolidated:true` flag,
  or a distinct kind) recording **why** the re-anchor happened (the branch slug / merge commit / the
  `clientToken` of the close) for audit.

The simplest contract delta: **one** new event kind `realization.anchored` with payload
`{ itemId, commit, reason?: 'consolidate', branchRef?, mergeCommit? }`. The fold sets
`item.realizedCommit = payload.commit`. That covers both "anchor at realize" (§2.3 can ALSO use this kind
instead of riding `realization.transition`) and "re-anchor at merge" with ONE additive kind.

### 3.2 Re-anchoring realized+accepted items WITHOUT mutation
"Re-anchor" = **append** a `realization.anchored{commit: mergeCommit}` for each done+accepted item whose work
the branch merged. The fold's last-write-wins on `realizedCommit` yields the new anchor; the prior anchor
stays in the log (full audit). After consolidation, every merged item's anchor **equals the merge commit on
main**, so a single post-merge read at any worktree finds them `fresh-at-anchor` against runs re-recorded at
(or shown ancestral to) the merge — and, critically, the *next* unrelated merge does NOT move *their* anchor,
so they never re-stale. The treadmill is broken at the source.

(If acceptance runs must also be at the merge commit, the skill records an `acceptance.run --commit
<mergeCommit>` per criterion as part of the close — also append-only, already-supported, no contract change.)

### 3.3 "GC the stale-by-unrelated-merge" in an append-only store
There is NO deletion. "GC" is expressed two ways, both append/read-only:
- **Annotating event**: append a `realization.anchored{reason:'consolidate'}` (and/or an
  `acceptance.consolidated` marker) that *supersedes* the stale-by-unrelated-merge verdict by giving the item
  a current anchor. The "garbage" (the stale flag) is not removed — it is **made unreachable by a newer
  anchor** the read prefers.
- **Read-filter**: the freshness projection already prefers `realizedCommit` (the anchor) over the moving
  HEAD (§2.4). An item with a consolidated anchor is simply no longer classified stale-by-unrelated-merge —
  the filter is the absence of the predicate firing, not a mutation.

So "GC" = *compensate by appending a superseding anchor* + *read prefers the anchor*; never a destructive op.
This stays inside track's record-only / append-only / frozen-event-contract constraints.

### 3.4 Terminal-DONE marker
"push done+accepted → a terminal DONE" maps onto the **existing** model without a destructive change:
- `Realization` already has `done` as a **terminal** state (no outgoing transitions —
  `REALIZATION_TRANSITIONS.done = []`). So "DONE terminal" is **already** the realization terminal; we do not
  need a new realization state.
- What "terminal-DONE" adds is **"done AND consolidated-accepted at the merge commit"** — i.e. the item is
  done *and* its acceptance is pinned fresh at the merge commit and will not re-stale. That is fully captured
  by the `realizedCommit = mergeCommit` anchor (§3.2) — a derived read state (`bucket = DONE` ∧
  `acceptance = pass` ∧ `anchor = mergeCommit`), NOT a new stored status axis. **No new realization enum
  value; no mutation of `done`.** If the conductor wants an explicit queryable marker, it is the
  `realization.anchored{reason:'consolidate'}` event itself (queryable in the log), not a new state.

### 3.5 The branches/worktrees SKILL
A new bundled skill (e.g. `skills/branch-lifecycle/SKILL.md`) ships through the **existing** `install-skills`
mechanism — `discoverSkills()` auto-discovers any `skills/<name>/SKILL.md` (no hardcoded list; dropping the
folder is all that is needed). It is track-aware (consumes the READ contract + the new consolidate verb),
analogous to the lane's `branch-init` / `post-branch-update` / `branch-close` / `scope-check`:

- **branch-init**: `track item new` / `scope.declare` the branch's WP/phase scope; mint the durable
  workspace id (`durableWorkspaceId`, already shipped) for the worktree.
- **post-branch-update**: on a rebase/update, recompute freshness via the READ contract; for any
  `needs-ancestry` verdict, run the caller-side `git merge-base` (§2.4) and, if ancestral, record/keep
  accepted.
- **scope-check**: existing `scope validate` fail-closed gate (unchanged).
- **branch-close** (the merge hook — *where the realizing/merge commit is known*): after the PR merges,
  the skill knows `mergeCommit`. It invokes **`track consolidate --merge-commit <sha> [--items …]`**, which
  appends the `realization.anchored{commit: mergeCommit}` (+ optional `acceptance.run --commit <mergeCommit>`)
  for the branch's done+accepted items. This is the consolidation invocation at the merge moment.

The skill computes the git side (merge-base, the merge commit, which items the branch touched); track records
the result. The **hook is the merge moment** because that is the only point at which the realizing commit (the
merge commit on main) is known.

**The heal is PER-MERGE, not permanent — a STANDING skill obligation:** `consolidate` re-stamps an item fresh
at the merge commit `M1` ONLY; the NEXT unrelated merge moves the baseline to `M2` and the strict cascade
(`accept/status.ts:25` literal `run.commit !== baselineCommit`) re-stales it — by design, the strict-status
invariant is preserved and the heal lives at the skill/consolidation layer. Therefore **the branch-lifecycle
SKILL MUST re-run `consolidate` on every subsequent merge that moves HEAD past a consolidated item**, else
those items re-bucket TO-DO under `requireAccepted`. This is INTENDED and MUST NOT be "fixed" by a future dev
reaching back to HEAD-relative acceptance (that is the original treadmill bug §1.3). A 2-merge regression test
pins it: consolidate at `M1` ⇒ pass at `M1`; query at `M2` ⇒ stale again; consolidate at `M2` ⇒ pass at `M2`.

### 3.6 Auto-reconciling the chat lane's 2 items
The chat lane has `chat-loop-guard-v2` → **cancelled** and `WP-CHAT B` → **done**. The consolidation verb
reconciles them **without the lane re-poking the store by hand**:
- `WP-CHAT B` (done+accepted): `track consolidate` appends `realization.anchored{commit: mergeCommit}` →
  its acceptance is pinned fresh at the merge commit, no longer treadmilled by #316/#295.
- `chat-loop-guard-v2` (cancelled): `cancelled` is already terminal and has **no acceptance axis pressure**
  (a cancelled item is DROPPED, not awaiting acceptance) — consolidation simply confirms its terminal state;
  no anchor needed. If the lane wants an audit marker, the same `realization.anchored{reason:'consolidate'}`
  with no acceptance side-effect records the close.

The skill enumerates the branch's items from the READ contract and calls `consolidate` once for the set —
the lane runs `branch-close`, nothing by hand.

### 3.7 Pros / cons
**Pros**
- Heals the **existing** backlog (re-anchors already-merged items (a) alone can't reach).
- Gives the **merge-time hook** — the only place the merge commit is known — and the skill to drive it.
- Auto-reconciles lanes; no hand-poking; append-only and fully auditable.

**Cons**
- New event kind (one) → INGEST + READ minor bump, fold + ingest mapping + facade method + CLI verb + MCP
  tool + skill — more surface than (a).
- Requires the skill/caller to know the merge commit and the branch's item set (git + log join) — correctly
  outside track, but it is integration the lane must wire.
- A consolidate that runs at the wrong commit mis-anchors (append-only ⇒ recoverable by a corrective
  `realization.anchored`, never a delete, but still operator care).

---

## 4. Recommendation — **both (a) and (b)**, layered

- **(a) is the semantic fix** and is **necessary**: without an item-anchored freshness, even a freshly
  consolidated item re-stales on the next unrelated merge, because the predicate would still be
  "run.commit === moving-HEAD". (a) makes freshness measured **against the item's own anchor**, which an
  unrelated merge does not move. Ship (a) first; it is the cheapest delta (one optional field) and it stops
  *new* treadmilling immediately.
- **(b) is the lifecycle hook** and is **necessary** to (i) heal the *existing* merged backlog (which has no
  anchor yet) and (ii) provide the merge-moment consolidation + the branches/worktrees skill the surfacing
  lane explicitly asked for, and to auto-reconcile the chat lane.
- They **compose**: (b)'s `realization.anchored` event is exactly the additive mechanism (a) needs to record
  an anchor — so building both means **one** new event kind (`realization.anchored`) serves realize-time
  anchoring (a) AND merge-time re-anchoring (b). This is the cheapest correct shape: do NOT split into two
  kinds.

Scoped to track's record-only nature: track **records** anchors and run commits and **classifies** the
purely-decidable rungs (`fresh-at-anchor` / `needs-ancestry`); the **git ancestry/merge-base judgement and
the merge-commit discovery live in the skill/caller**. track never gains git.

**Phasing**: (a) `realization.anchored` kind + anchor-preferring freshness projection → ship, unblocks new
items. (b) `track consolidate`/`branch-close` verb + the `branch-lifecycle` skill → ship, heals the backlog
and wires the hook.

---

## 5. Frozen-contract impact

**Additive (new):**
- ONE new event kind: **`realization.anchored`**, payload `{ itemId, commit, reason?, mergeCommit?,
  branchRef? }`. Folds `ItemState.realizedCommit`. (Serves both (a) realize-time and (b) merge-time anchors.)
- ONE new optional `ItemState.realizedCommit?: string` (derived; absent ⇒ fall back to `baselineCommit`).
- ONE new WorkEvent kind **`item.consolidate`** (→ facade `consolidate`/append `realization.anchored`),
  `settles: 'always'` (re-anchoring a merge is trust-sensitive like `item.reparent`).
- Optionally a `commit?` field on the existing `item.realize` payload (if anchoring at realize-time via the
  existing transition instead of a separate `realization.anchored` — pick ONE; the separate kind is cleaner
  and reused by (b)).
- New computed read rungs `fresh-at-anchor` / `needs-ancestry` on the `CriterionStatus` projection (the
  union `CriterionStatus` GROWS — allowed under READ contract additive-only policy).
- New CLI verb `track consolidate` / `track branch-close`; new MCP tool `track_consolidate`; new bundled
  skill `branch-lifecycle` (auto-installed by the existing `install-skills`).

**Stays byte-identical:**
- Every pre-existing event: `canonicalize` drops `undefined`, the new optional payload field and the new
  kind do not touch any existing event's bytes/hash/seq. Existing `realization.transition`, `acceptance.run`,
  all folds for them unchanged. The integrity chain (`validate`) is unaffected (it is kind-agnostic over the
  hash chain).
- `baselineCommit` parameter and all existing read signatures stay (additive `anchorCommit` is internal /
  derived; callers unchanged).

**Version bumps:**
- INGEST contract `1.1.0` → **`1.2.0`** (new optional WorkEvent kind `item.consolidate` + optional
  `item.realize.commit`; no kind removed, no required field added, envelope keys unchanged ⇒ MINOR).
- READ contract `1.9.0` → **`1.10.0`** (new `CriterionStatus` rungs + the consolidate verb's read effects;
  surface only GROWS ⇒ MINOR).
- EVENT_TYPES gains `realization.anchored` (additive; old logs validate). Package: a MINOR `feat`.

---

## 6. Open questions (owner / chat lane / conductor)

1. **(SHARPEST) Does the ancestry/merge-base judgement live in track or the skill?** This design says the
   **skill** (track stays git-agnostic; track only does the purely-decidable `fresh-at-anchor` equality and
   emits `needs-ancestry` with both SHAs). Confirm — if the owner wants track to call git, it breaks the
   record-only/no-git invariant (`TrackReader` "Holds NO git"). **Recommended: skill computes ancestry; track
   never gains git.**
2. **One event kind or two?** This design reuses ONE `realization.anchored` for both realize-time (a) and
   merge-time (b) anchoring, vs adding `commit?` to `item.realize` AND a separate consolidate kind. Confirm
   the single-kind shape.
3. **Exact terminal-DONE semantics**: is "terminal-DONE" purely a derived read state (done ∧ accepted ∧
   anchor=mergeCommit), or does the conductor want an explicit queryable marker event? This design uses the
   `realization.anchored{reason:'consolidate'}` event as the queryable marker and adds **no** new realization
   enum value. Confirm no new realization state is wanted.
4. **Does `consolidate` also re-record the acceptance runs at the merge commit**, or only re-anchor the
   realization? Re-anchoring alone leaves run.commit ≠ mergeCommit (→ `needs-ancestry`, an extra git call per
   read); also recording `acceptance.run --commit <mergeCommit>` makes the post-merge read purely-decidable
   `fresh-at-anchor`. Recommended: the skill does BOTH at close (both are append-only, already supported).
5. **Multi-worktree (WP4) interaction**: with per-item anchors, freshness is no longer worktree-HEAD-relative
   — good. But which worktree/agent is authorized to run `consolidate` (the merge happens on main; the lane's
   worktree may be elsewhere)? Likely the main-worktree / the merging agent. `item.consolidate` is
   `settles:'always'` (trust-gated); confirm the authorization model with the conductor + h2a RACI.
6. **Pre-(a) backlog**: items done before this ships have no anchor. Do we run a one-time consolidation pass
   over the existing merged backlog (a `branch-close` per already-merged branch, or a bulk anchor at the
   current main HEAD), or let them fall back to HEAD-equality until each is re-touched? Recommended: a
   one-time bulk `consolidate` at the current main HEAD for all done+accepted items.
