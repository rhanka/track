---
name: track-operation
description: "Use when an agent needs to read, update, import, or verify track state in a repo; when a BRANCH.md or plan/NN-BRANCH_*.md file changed; when a session reports that track write/import is not exposed; or when deciding whether to use track MCP versus the track CLI. The skill enforces the contract: MCP is read-only, writes/imports use the track CLI from the target repo root, and .track is append-only/single-writer."
---

# Track Operation

Use this for ordinary track hygiene: reading status, importing BRANCH files, recording item or decision
updates, and verifying that the sidecar is current. This is the general operational skill; use
`present-decision` for human decision dossiers and `propose-workpackages` for backlog restructuring.

## Contract

- The `track` MCP server is read-only by design. MCP tools may report, query, validate, inspect canvas
  state, or show cursor/status data; they must not append to `.track/`.
- Do not treat missing MCP write/import tools as a blocker. Writes and imports are CLI operations.
- Run CLI writes from the target repository root, never from a different checkout. `track branch import
  ../other-repo/plan/X.md` writes to the current repo's `.track/`, not the other repo's store.
- `.track/events.jsonl` is append-only and single-writer. Do not write or commit `.track/` from a
  concurrent worktree unless the user has explicitly designated that worktree as the writer.

## Before A Write

1. Confirm the repository root you are operating in.
2. Confirm `.track/` exists. If it is absent, recommend `track init` and stop unless the user explicitly
   asked to initialize tracking.
3. If you are in a concurrent worktree, update the mergeable source artifact instead, usually the
   `plan/NN-BRANCH_*.md` file. Leave `.track/` import to the designated writer checkout unless told
   otherwise.

## BRANCH Import

When progress is represented by a `BRANCH.md` or `plan/NN-BRANCH_*.md` file:

1. Update the checkboxes in the BRANCH file. Keep the BRANCH file as the source of truth.
2. From the same repo root, run:

   ```bash
   track branch import plan/<BRANCH_FILE>.md
   ```

3. Verify immediately:

   ```bash
   track report --format text
   track validate
   ```

4. If the import reports `0 created, 0 updated`, that is a valid idempotent result when the sidecar was
   already current.

## Direct Writes

Use direct CLI writes only for the event they actually represent:

- New item: `track item new --kind <feature|bug|chore> --title "<title>" --workspace <workspace>`
- Realization: `track item realize <itemId> <in-progress|done|cancelled>`
- Decision dossier: `track decision dossier <decisionId> --context <context>`
- Artifact evidence: `track decision add-artifact <decisionId> ...`
- Workpackage changes: follow `propose-workpackages`; do not reparent without human approval.

## Reporting Back

Report track results from the verified state, not from memory:

- Use `track report --format text` for human status. Since track 0.19.1 this prefers the WP/table
  conductor view (FAIT / À-FAIRE %·WP / ATTENDUS) when workpackages exist, and falls back to flat buckets
  in unstructured repos.
- Use `track report --wp` only to force the conductor table explicitly. Use legacy `track report --flat`
  only when the user asks for flat buckets or a downstream script still needs them; treat `--flat` as
  deprecated for human reporting.
- Mention if `.track/` was intentionally not written because the current checkout is not the designated
  writer.

## Do Not

- Do not say "track write/import is not exposed" when the CLI exists. The correct statement is "MCP is
  read-only; I will use the track CLI from the repo root."
- Do not initialize tracking in another repo without explicit user approval.
- Do not manually edit `.track/events.jsonl` except for a deliberate repair with owner approval.
- Do not commit `.track/` updates produced from the wrong repo root or an undesignated concurrent worktree.

## Per-Agent Mapping

| Capability | Claude | Codex | Gemini-agy |
| --- | --- | --- | --- |
| skill entrypoint | `~/.claude/skills/track-operation/SKILL.md` | `~/.codex/skills/track-operation/SKILL.md` | `~/.gemini/commands/track-operation.toml` |
| read tools | track MCP or CLI report/query/validate | track MCP or CLI report/query/validate | track MCP or CLI report/query/validate |
| write/import tools | `track` CLI | `track` CLI | `track` CLI |

Existing repo methods win on conflict. If a repo has a harness flow, let harness own the BRANCH artifact and
use `track branch import` to project it into the track sidecar.
