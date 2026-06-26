#!/usr/bin/env bash
set -euo pipefail

HOOK="${1:-$(pwd)/.claude/hooks/pre-bash-git-dogfood-guard.sh}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cd "$tmp"
git init -q
git config user.email test@example.invalid
git config user.name 'Guard Test'
mkdir -p .track
echo '{}' > .track/events.jsonl
git add .track/events.jsonl
git commit -qm init

run_hook() {
  local cmd="$1"
  printf '{"tool_input":{"command":%s}}' "$(python3 - <<PY
import json
print(json.dumps('$cmd'))
PY
)" | "$HOOK" >/tmp/guard-test.out 2>/tmp/guard-test.err
}

expect_pass() {
  local cmd="$1"
  if ! run_hook "$cmd"; then
    echo "expected pass but blocked: $cmd" >&2
    cat /tmp/guard-test.err >&2
    exit 1
  fi
}

expect_block() {
  local cmd="$1"
  if run_hook "$cmd"; then
    echo "expected block but passed: $cmd" >&2
    exit 1
  fi
  grep -q 'BLOCKED: destructive git command while .track has uncommitted changes' /tmp/guard-test.err
  grep -q 'TRACK_ALLOW_DESTRUCTIVE_GIT=1' /tmp/guard-test.err
}

# Clean .track: destructive command is allowed by the guard.
expect_pass 'git reset --hard HEAD'

# Dirty .track: read-only commands pass, destructive commands block.
echo dirty >> .track/events.jsonl
expect_pass 'git status --short'
expect_pass 'git clean -nfd'
expect_pass 'git clean --dry-run -fd'
expect_pass 'TRACK_ALLOW_DESTRUCTIVE_GIT=1 git reset --hard HEAD'
expect_block 'git reset --hard HEAD'
expect_block 'cd /tmp && git -C .'"$tmp"' reset --hard HEAD'
expect_block 'set -e; git checkout main'
expect_block 'git clean -fd'

echo 'git dogfood guard tests: ok'
