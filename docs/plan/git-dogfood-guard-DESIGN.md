# WP-git-dogfood-guard — Claude hook prevents destructive git sync from discarding `.track` dogfood state

Status: DESIGN DRAFT (pending consensus review)
Owner: track lane
Workspace: track
Track WP: `01KW147QYZ0F5V2KTR4XE14GX8`

## 0. Problem
During the `@sentropic/track@0.19.0` (`track focus`) ship, a sync step ran `git reset --hard origin/main` while dogfood `.track` events were still uncommitted. Git behaved correctly, but the workflow lost in-flight `.track` state and item realization regressed.

This is exactly the class of operator footgun that a local harness guard should catch: track events are the product/system-of-record dogfood state, but until committed they are ordinary working-tree bytes.

## 1. Goal
Add a project-scoped Claude Code hook that blocks destructive git commands before execution when `.track/` contains uncommitted changes.

The guard is intentionally local/workflow-level. It does **not** change Track's event, READ, or INGEST contracts.

## 2. Scope
### Guarded commands
The hook should inspect Bash commands before execution and block commands that are likely to discard or overwrite worktree state:

- `git reset --hard ...`
- `git checkout ...` and `git switch ...` when used for branch/ref changes (conservative block if `.track` dirty)
- `git clean ...` when it can delete files (especially with `-f`, `-d`, `-x`, `-X`)

Read-only commands (`git status`, `git log`, `git diff`, `git fetch`, `git branch --show-current`, etc.) must not be blocked.

### Dirty predicate
Use:

```bash
git status --porcelain -- .track
```

If output is non-empty, `.track` has uncommitted state (tracked modifications or untracked files) and destructive commands must be blocked.

### Bypass
Provide an explicit, grep-able bypass for intentional destructive operations:

```bash
TRACK_ALLOW_DESTRUCTIVE_GIT=1 git reset --hard origin/main
```

The bypass must be named in the block message. Default posture is fail-closed.

## 3. UX
On block, print a message like:

```text
BLOCKED: destructive git command while .track has uncommitted changes.
Risk: uncommitted Track dogfood events would be discarded/regressed.
Remediation: commit/stash .track first, or set TRACK_ALLOW_DESTRUCTIVE_GIT=1 if you intentionally accept losing that state.
Dirty .track entries:
  M .track/events.jsonl
```

Exit non-zero so Claude Code does not run the Bash tool.

## 4. Implementation shape
- Project-scoped Claude settings: `.claude/settings.json`.
- `PreToolUse` hook for the Bash tool.
- Small checked-in script, e.g. `.claude/hooks/pre-bash-git-dogfood-guard.sh`, to keep JSON readable.
- The script reads the tool input JSON on stdin (Claude hook contract), extracts `.tool_input.command`, decides whether it is a destructive git command, checks `.track` dirty state, and exits non-zero with the message on block.

## 5. Tests / validation
Minimum validation:

1. With clean `.track`, hook script permits `git reset --hard origin/main`.
2. With dirty `.track`, hook script blocks `git reset --hard origin/main` and message contains risk/remediation.
3. With dirty `.track`, hook script permits `git status --short`.
4. With dirty `.track`, hook script permits the destructive command when `TRACK_ALLOW_DESTRUCTIVE_GIT=1` is set.

These can be script-level tests that feed representative hook JSON into the hook script. Avoid actually running destructive git in the repo test.

## 6. Non-goals
- No Track core contract changes.
- No attempt to solve every shell parsing case; use conservative regex for common destructive git commands. Err toward blocking when `.track` is dirty.
- No global/user hook by default; this is project-local and auditable in the repo.

## 7. Acceptance criteria (tracked)
- Destructive git command is blocked before execution when `.track` is dirty.
- Non-destructive git and destructive git with clean `.track` continue unchanged.
- Message names risk and remediation.
- Local/project-scoped; no event/read/ingest contract change.

## 8. Consensus review outcome
Consensus requested over h2a on 2026-06-26.

- Architect (`claude:architect:ed8bbd8bf573`): **SHIP** — correct layer, project-local/auditable, blocks before Bash execution, right dirty predicate, no Track contract change.
- Remote reviewer (`claude:remote:86a3bf96c89b`): **SHIP_WITH_NITS** — harden shell parsing and tests.

Nits integrated in implementation:
- Robust hook JSON parsing with safe allow on parse noise rather than breaking all Bash usage.
- Handles common shell wrappers (`set -e;`, `cd repo && git ...`) and `git -C path ...`.
- Allows `git clean -n`, `git clean -nfd`, `git clean --dry-run ...`; blocks deleting clean forms.
- Conservative `checkout`/`switch` block when `.track` is dirty (including path checkout); UX documents why.
- Script-level tests use a temporary git repo and never execute destructive git against the real working repo.
