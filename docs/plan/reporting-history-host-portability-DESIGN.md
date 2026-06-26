# Reporting history and host portability design

> Date: 2026-06-17
> Status: draft before double review (Codex gpt-5.5 xhigh x2)
> Track item: `01KVBZHGD30G88WQYEWEZH89WK`
> Owning WP: WP2 - Reporting & Conductor Pilotage

## Problem

Track currently has the right low-level posture but not enough product guidance for agents.

- MCP is intentionally read-only, but Codex agents can misread "no MCP write/import tool" as "track cannot
  be written". The published `track-operation` skill fixed the routing contract, but its reporting
  instructions are still too weak.
- `track report --wp` has the correct three-section shape (`FAIT`, `A-FAIRE`, `ATTENDUS`), but the text is
  too skeletal for conductor work: open and awaited items are not ID-addressable in the human summary, and
  the skill does not force the agent to spell out expected decisions/actions.
- The append-only log already preserves hidden history, but there is no ergonomic read surface for "show me
  the exhaustive history" without opening `.track/events.jsonl`.
- Host parity is incomplete. Claude/Codex use verbatim `SKILL.md`; Gemini/agy use generated TOML commands;
  Mistral Vibe and OpenCode both have native skill search paths locally, but `install-skills` does not target
  them yet.

## Non-negotiables

1. MCP stays read-only. No write/import MCP tools in this feature.
2. Writes/imports stay CLI operations from the target repo root.
3. Normal reports stay concise. Historical DONE/churn remains hidden by default.
4. Exhaustive history must be available on explicit request through a supported read surface.
5. The in-repo `skills/` bundle remains the single source of truth. Host adapters copy or translate it; they
   do not fork skill text.

## Deliverables

### D1 - Conductor report output

Keep `track report --wp` as the normal conductor view, but make it more actionable:

- `A-FAIRE` open leaf lines include the item id: `- <title> [<id>]`.
- `ATTENDUS` lines include item id, WP label, and disposition: `decision: owner` or `action: agent`.
- The renderer remains a projection over the WP forest; no new event data.
- JSON stays back-compatible: existing `wpTree` and `wpTotals` remain, and any additive fields must be optional.

The renderer should not dump every historical DONE leaf in `FAIT`. `FAIT` remains a current-state summary:
global progress and completed top-level WPs. Detailed historical completion belongs to D2.

### D2 - Hidden/exhaustive history read

Add an explicit read surface:

```bash
track history [--workspace <w>] [--aggregate <id>] [--type <event-type>] \
  [--since <iso>] [--limit <n>|--all] [--format json|text|md]
```

Library API:

```ts
interface HistoryFilter {
  workspace?: string
  aggregateId?: string
  type?: EventType
  since?: string
  limit?: number
}

interface HistoryEntry {
  streamIndex: number
  aggregateSeq: number
  at: string
  type: EventType
  aggregate: Aggregate
  aggregateId: string
  title?: string
  workspace?: string
  by: ActorId
  prov?: Provenance
  summary: string
  payload: Readonly<Record<string, unknown>>
}
```

Rules:

- `TrackReader.history(filter)` reads the log and returns entries in stream order.
- `limit` keeps the last N matching entries while preserving stream order. CLI default: `50`; `--all`
  disables the limit.
- `workspace` is resolved from folded item/decision state plus event payloads where possible. If an event
  cannot be assigned to the requested workspace, it is excluded.
- `summary` is deterministic and bounded. It must never require ad hoc JSON parsing by a skill.
- `json` includes the normalized entries including `payload`; `text`/`md` render one bounded line per entry.
- Add read-only MCP tool `track_history` over the same command layer so MCP users can ask for exhaustive
  history without direct file access.

This is the "hidden history": it exists in `.track/events.jsonl`, normal reports do not show it, and a user
can request it explicitly through `track history`.

### D3 - `track-operation` skill reporting contract

Update `skills/track-operation/SKILL.md`:

- Normal status: run `track report --wp --format text` when workpackages exist, otherwise
  `track report --format text`.
- Human report must use three sections:
  - `Fait`: what is verified complete/currently done; do not dump old history unless requested.
  - `A faire`: active next items grouped by WP with IDs and the immediate next action.
  - `Attendus`: explicit expected decision/action, expected owner (`owner`, `agent`, or named actor if
    visible), and what unblocks after it.
- Exhaustive status: when the user asks for history/exhaustive/complet, run `track history ...` in addition
  to `track report --wp`.
- Never say "track write/import is not exposed" when the CLI exists. Say "MCP is read-only; I will use the
  track CLI from the repo root."

### D4 - Host ports

Existing:

- `claude`: copy `skills/<name>/...` to `~/.claude/skills/<name>/...`
- `codex`: copy to `~/.codex/skills/<name>/...`
- `gemini` and `agy`: generate `~/.gemini/commands/<name>.toml`

Add/verify:

- `vibe`: copy `skills/<name>/...` to `~/.vibe/skills/<name>/...` for user scope and
  `<repo>/.vibe/skills/<name>/...` for project scope. Local Mistral Vibe discovers both locations through
  its `HarnessFilesManager`/`SkillManager`; no TOML mutation is required for the default path.
- `opencode`: copy `skills/<name>/...` to an OpenCode skills directory and register that directory through
  `opencode.json` `skills.paths`.
  - user scope: `~/.config/opencode/skills/sentropic-track/<name>/SKILL.md` plus
    `~/.config/opencode/opencode.json` containing `{"skills":{"paths":["~/.config/opencode/skills/sentropic-track"]}}`
    merged with existing JSON.
  - project scope: `<repo>/.opencode/skills/sentropic-track/<name>/SKILL.md` plus project
    `<repo>/opencode.json` containing `{"skills":{"paths":[".opencode/skills/sentropic-track"]}}`
    merged with existing JSON.

Do not add `mistral` as a separate host name unless a separate CLI format is verified. On this machine,
Mistral's coding CLI is `vibe`.

Future host candidates to leave documented but not ship in this feature:

- Aider: likely repo instructions rather than native skills; defer until installed/config format is verified.
- Qwen Code: likely Gemini-command-compatible in some installs, but not verified locally.
- Cursor: already consumes `AGENTS.md`-style project instructions; no native skill bundle target verified.

## Tests

- `report-revamp`: `track report --wp` text includes IDs for open and awaited leaves, preserves no flat bucket
  dump, and keeps markdown escaping scoped to `md`.
- `history`: `TrackReader.history` filters by aggregate, workspace, type, since, limit; CLI renders text/json;
  `--all` returns all matches; empty/unadopted repo serves an empty history.
- MCP: `track_history` mirrors the CLI/read command result and remains side-effect-free.
- `track-operation`: installed Codex/Gemini/Vibe/OpenCode skill text contains the CLI-vs-MCP write contract
  and the reporting contract.
- `install-skills`: `--host all` includes `vibe` and `opencode`; `gemini` and `agy` both produce
  `track-operation.toml`; OpenCode JSON merge preserves unrelated config and is idempotent.

## Acceptance

The feature is done when:

1. A Codex session with the installed skill can no longer reasonably answer "track write/import is not
   exposed" for a writable repo.
2. `track report --wp` gives a concise conductor status with addressable `A-FAIRE` and `ATTENDUS` rows.
3. `track history --workspace track --all --format text` exposes the hidden append-only history without
   changing normal report verbosity.
4. `track install-skills --host gemini --host agy --host vibe --host opencode --force` installs or updates the
   relevant host artifacts in an idempotent way.
5. Full test suite and build pass.

## Owner clarification — default directive posture and Objective Loop alignment

> Added: 2026-06-26 from owner feedback.

Track must stop being a passive inventory. Its default product posture is **conductor-oriented**:

1. A normal status answer is not a loose bucket dump. It is a WP-by-WP operating table:
   - `WP`
   - current state / percent
   - `Fait`
   - `A faire`
   - recommended next action
   - expected owner / execution mode (`local`, `subagent`, `remote`, `h2a`, `human decision`)
   - blocking decision, if any
2. Track should proactively relaunch the remainder of engaged tracks using the retained execution mode when that mode is known from provenance, delegation, h2a objective refs, or worktree/agent metadata.
3. Agent UX rule: do not end with “si tu veux” for reversible continuation. Default is to continue until:
   - all engaged actions are exhausted;
   - a non-reversible action would be taken;
   - a required human/owner decision is unavoidable;
   - or evidence/acceptance is missing and cannot be produced by the current agent.
4. Track reports should therefore produce an explicit `Prochaines actions preconisees` section, not merely state backlog facts.
5. This aligns with H2A Objective Loop as follows:
   - H2A owns the cross-repo/cross-agent objective aggregate and live engagement loop.
   - Track owns structured repo-local refs, WP/item/decision rollups, acceptance/evidence, and recommended next repo actions.
   - Objective refs may point to multiple Track aggregates, not one WP only.
   - Track must expose enough structured status for H2A to resume/route work without rereading prose.

### Implication for this WP2 feature

D1 is upgraded from “more actionable report” to “directive conductor report”. The target default output is a compact table, for example:

| WP | Etat | Fait | A faire | Prochaine action | Mode | Decision |
|---|---:|---|---|---|---|---|
| WP2 Reporting | 40% | design drafted | implement history/read surface | add `TrackReader.history` + `track history` | local/subagent | none |
| WP6 Canevas | 20% | read surfaces exist | host submit loop | ask h2a/sentropic for host contract if absent | h2a | host write-path decision |

The CLI may keep text/JSON/MD formats, but the default human text must be prescriptive:

- `FAIT` = verified or currently completed state, not old hidden history.
- `A FAIRE` = live remaining work, grouped by WP and item id.
- `PROCHAINES ACTIONS` = Track's recommended continuation queue.
- `DECISIONS` = unavoidable owner/human choices only.

This is the Track-side counterpart to Objective Loop: Objective Loop drives continuation across agents; Track provides the repo-local factual/actionable projection and does not launder machine suggestions as human decisions.
