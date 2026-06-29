#!/usr/bin/env bash
# branch-lifecycle / check.sh — the B0 merge-loss gate (DESIGN Lot B).
#
# Performs a REAL git trial-merge of the branch into the base in a throwaway worktree, then asserts the
# post-merge `.track` log CONTAINS every event id on the branch, via `track events-contains`. FAILS the
# build on non-containment (a committed event would be lost by the merge).
#
# The predicate is CONTAINMENT, never "squash vs merge-commit":
#     events(post-merge real) ⊇ events(branch)
# Recommendation: merge PRs that touch `.track` with a MERGE COMMIT (two real parents) so this check
# operates on the actual merge — but the gate is containment, NOT "is it a merge commit" (that proxy both
# misses real losses and blocks harmless squashes). The check fails closed on any candidate it cannot
# evaluate, so a lossy or conflicting merge is blocked regardless of the merge driver.
#
# Env (all optional):
#   BASE_REF   integration target            (default: origin/main)
#   BRANCH_REF branch being merged/closed     (default: HEAD)
#   TRACK_LOG  event-log path within the repo (default: .track/events.jsonl)
#   TRACK_BIN  track CLI to invoke            (default: track)
#
# Exit: 0 = containment holds (no loss); 1 = LOSS detected; 2 = cannot evaluate (setup error).
set -euo pipefail

BASE_REF="${BASE_REF:-origin/main}"
BRANCH_REF="${BRANCH_REF:-HEAD}"
TRACK_LOG="${TRACK_LOG:-.track/events.jsonl}"
TRACK_BIN="${TRACK_BIN:-track}"

WORKTREE=""
TMPDIR_BL=""
cleanup() {
  [ -n "$WORKTREE" ] && git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  [ -n "$TMPDIR_BL" ] && rm -rf "$TMPDIR_BL" || true
}
trap cleanup EXIT

BASE_SHA="$(git rev-parse --verify "${BASE_REF}^{commit}" 2>/dev/null)" || {
  echo "branch-lifecycle: cannot resolve BASE_REF '$BASE_REF' — cannot evaluate" >&2; exit 2; }
BRANCH_SHA="$(git rev-parse --verify "${BRANCH_REF}^{commit}" 2>/dev/null)" || {
  echo "branch-lifecycle: cannot resolve BRANCH_REF '$BRANCH_REF' — cannot evaluate" >&2; exit 2; }

# Already merged? Then the base trivially contains the branch — nothing to gate.
if git merge-base --is-ancestor "$BRANCH_SHA" "$BASE_SHA"; then
  echo "branch-lifecycle: $BRANCH_REF already an ancestor of $BASE_REF — containment trivially holds"
  exit 0
fi

TMPDIR_BL="$(mktemp -d)"
BASE_LOG="$TMPDIR_BL/branch-events.jsonl"

# The set that MUST survive the merge = the branch tip's event log. If the branch has no `.track` log,
# there is nothing to protect.
if ! git show "${BRANCH_SHA}:${TRACK_LOG}" >"$BASE_LOG" 2>/dev/null; then
  echo "branch-lifecycle: no $TRACK_LOG on $BRANCH_REF — nothing to gate"
  exit 0
fi

# Trial-merge the branch into the base in an isolated worktree. We do NOT commit; we only need the merged
# working-tree log. Without a union merge driver (deferred — see SKILL.md), a divergent event log
# CONFLICTS, leaving conflict markers in the candidate; `events-contains` then reads it as malformed and
# returns rc=2 ⇒ this gate FAILS CLOSED (a lossy/conflicting merge is blocked, never silently passed).
# (A future `.gitattributes merge=union`, paired with a `reseal` verb, would auto-reconcile disjoint
# appends cleanly so the common case reads as rc=0 instead of rc=2.)
WORKTREE="$TMPDIR_BL/wt"
git worktree add --detach "$WORKTREE" "$BASE_SHA" >/dev/null
git -C "$WORKTREE" merge --no-ff --no-commit "$BRANCH_SHA" >/dev/null 2>&1 || true

CANDIDATE="$WORKTREE/$TRACK_LOG"
if [ ! -f "$CANDIDATE" ]; then
  echo "branch-lifecycle: post-merge $TRACK_LOG missing — cannot evaluate containment" >&2
  exit 2
fi

# The gate: post-merge log must contain every branch event id.
set +e
"$TRACK_BIN" events-contains --base "$BASE_LOG" --candidate "$CANDIDATE"
RC=$?
set -e

case "$RC" in
  0) echo "branch-lifecycle: OK — post-merge $TRACK_LOG contains every branch event id" ;;
  1) echo "branch-lifecycle: FAIL — the merge would DROP branch events (see ids above)" >&2 ;;
  *) echo "branch-lifecycle: FAIL — events-contains could not evaluate (rc=$RC)" >&2 ;;
esac
exit "$RC"
