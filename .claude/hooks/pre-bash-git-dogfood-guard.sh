#!/usr/bin/env bash
# Claude Code PreToolUse hook: protect uncommitted Track dogfood state from destructive git commands.
set -euo pipefail

# Explicit bypass for intentional destructive operations.
if [[ "${TRACK_ALLOW_DESTRUCTIVE_GIT:-}" == "1" ]]; then
  exit 0
fi

payload="$(cat)"
classification="$(PAYLOAD="$payload" python3 - <<'PY'
import json, os, re, shlex, sys

payload=os.environ.get('PAYLOAD','')
try:
    data=json.loads(payload)
except Exception:
    # Cannot know the command; do not break all Bash usage on hook-schema noise.
    print('ALLOW\n')
    raise SystemExit

cmd=(data.get('tool_input') or {}).get('command') or data.get('command') or (data.get('toolInput') or {}).get('command') or ''
if not isinstance(cmd, str) or not cmd.strip():
    print('ALLOW\n')
    raise SystemExit

# Inline bypass, e.g. TRACK_ALLOW_DESTRUCTIVE_GIT=1 git reset --hard ...
if re.search(r'(^|[\s;&|])TRACK_ALLOW_DESTRUCTIVE_GIT=1([\s;&|]|$)', cmd):
    print('BYPASS\n' + cmd)
    raise SystemExit

# Split common shell command separators while preserving enough text for grep-able diagnostics.
segments=[]
for line in cmd.splitlines():
    segments.extend(re.split(r'\s*(?:&&|;|\|\|)\s*', line))

# Conservative destructive git detector. It intentionally catches common wrappers:
#   cd repo && git reset --hard ...
#   git -C repo reset --hard ...
#   /usr/bin/git checkout main
# It does not execute the command or fully parse shell syntax.
def tokens(segment: str):
    try:
        return shlex.split(segment, posix=True)
    except Exception:
        return []

def git_argv(segment: str):
    t=tokens(segment)
    for i, tok in enumerate(t):
        if tok == 'git' or tok.endswith('/git'):
            return t[i:]
    return []

def clean_is_dry_run(argv):
    return any(a == '--dry-run' or re.fullmatch(r'-[A-Za-z]*n[A-Za-z]*', a or '') for a in argv)

def is_destructive_git(segment: str):
    argv=git_argv(segment)
    if not argv:
        return False
    # Drop global git options (`git -C path reset --hard`, `git -c k=v reset --hard`).
    i=1
    while i < len(argv):
        a=argv[i]
        if a in ('-C', '-c', '--git-dir', '--work-tree', '--namespace') and i+1 < len(argv):
            i += 2
            continue
        if a.startswith('-'):
            i += 1
            continue
        break
    if i >= len(argv):
        return False
    sub=argv[i]
    rest=argv[i+1:]
    if sub == 'reset' and '--hard' in rest:
        return True
    if sub == 'clean' and not clean_is_dry_run(rest):
        return True
    if sub in ('checkout', 'switch'):
        # Conservative: branch/ref checkout can replace worktree state. `git checkout -- path`
        # is also worktree-discarding, so blocking when .track is dirty is acceptable.
        return True
    return False

for seg in segments:
    if is_destructive_git(seg):
        print('DESTRUCTIVE\n' + cmd)
        raise SystemExit
print('ALLOW\n' + cmd)
PY
)"

kind="${classification%%$'\n'*}"
command_text="${classification#*$'\n'}"

case "$kind" in
  ALLOW|BYPASS) exit 0 ;;
  DESTRUCTIVE) ;;
  *) exit 0 ;;
esac

# If not in a git worktree, allow; there is no .track state to protect here.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

# Protect only Track dogfood state.
dirty="$(git status --porcelain -- .track 2>/dev/null || true)"
[[ -n "$dirty" ]] || exit 0

cat >&2 <<MSG
BLOCKED: destructive git command while .track has uncommitted changes.
Risk: uncommitted Track dogfood events would be discarded/regressed.
Remediation: commit or stash .track first, or set TRACK_ALLOW_DESTRUCTIVE_GIT=1 if you intentionally accept losing that state.

Command:
  $command_text

Dirty .track entries:
$dirty
MSG
exit 2
