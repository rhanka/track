---
name: propose-workpackages
description: Use when a flat track backlog has grown past a handful of items and needs structuring into a small set of perennial workpackages (WPs) — durable themes by owning concern, not milestones — so a conductor can pilot %-by-WP. The skill reads the backlog, clusters by durable concern, and EMITS A PROPOSAL (the WP set + a per-item reparent plan) the human ratifies before anything is written. It never auto-restructures; for a consequential restructuring it composes present-decision. This is agent→human structuring of one repo's own backlog.
---

# Propose Workpackages

Turn a **flat backlog** into a small set of **perennial workpackages** — durable themes keyed to an
**owning concern / artifact**, not to a milestone or a date. You **propose**; the human **ratifies**;
only then do you write. This skill automates what a conductor otherwise does by hand to keep a backlog
legible and pilotable by `%`-per-WP.

This skill is **tool-neutral**. Where it names a capability ("your code-search tool", "your modal-ask
tool", "your second-opinion agent"), use your host's equivalent — see **Per-agent mapping** at the end.
It works on **the repo it is invoked in**; it never imposes a global standard and never edits another
repo's rules.

## Step 0 — Precondition (track present?)

If `.track/` is absent, do not structure anything: **recommend `track init`** and stop. Workpackages are
represented *in* track (a parent `Item` with `role:'workpackage'`, children via `parentId`); without a
store there is nothing to mark or roll up. If track is present, read the live state before proposing.

## Step 1 — Read the flat backlog

Pull the backlog as data, not from memory. Use your code-search tool to ground every claim in the actual
items.

- **`track report --format json`** — the bucketed view: each row carries `id`, `title`, `kind`, `bucket`,
  and (when set) `accountable`, `engagementRef`, `role`. WPs (`role:'workpackage'`) are excluded from the
  flat buckets — an already-structured repo shows them under `track report --wp`.
- **`track query --format json`** (optionally `--role workpackage`) and **`track item show <id>`** for the
  **existing hierarchy** — `parentId`, current parents, what is already a WP. Reparenting operates on `id`,
  so resolve the real ids before proposing a plan.
- **`track report --wp`** when WPs already exist — the fait / à-faire %·WP / attendus view tells you what is
  already structured and what is still homeless.

## Step 2 — Cluster by DURABLE concern, NOT milestone

Group items by the **concern / owning artifact** each one serves — the thing that will still exist in a
year — not by the release it happens to land in.

- **Down-weight timeline prefixes.** `M\d`, `v\d`, `BR-\d`, `Lot`, sprint/wave names encode *when*, not
  *what*. They are timeline, not theme. Map a milestone-tagged item to the **concern** it advances (e.g. a
  "M5 wiring" item → the *record contract* concern), and ignore the prefix for clustering.
- **Preserve owner-level distinctions** (heuristic §5). Do not collapse items that have genuinely different
  owners or sides of a seam: record-side vs render vs logic; a decision *referent* (e.g. D5 mockups, held as
  record evidence) vs a render *contract* (e.g. M5, owned elsewhere). When two items look thematically close
  but sit on opposite sides of an ownership seam, they belong to **different** WPs.

## Step 3 — Shape 4–7 perennial workpackages

Aim for **4–7** WPs. Each is a **container of a durable concern**, written as **a one-line charter + an
explicit scope boundary** (what is NOT here, and where it lives instead — name the neighbouring WP).

Reject, and rework until none remain:
- **"misc" / "other" / "general"** — a catch-all means the taxonomy is incomplete, not that a bucket is
  needed. Find the real concern.
- **single-ticket WPs** — one todo is not a perennial theme; fold it into the concern it serves.
- **milestone-only names** — "M5", "v2", "Lot 3" name a date, not a concern. Rename to the owning artifact.

A good WP reads like *"Record Integrity & Contract — the append-only log never lies … NOT the write
transports (→ Write Surfaces), NOT the render (→ Views)."* (Precedent: `docs/plan/workpackages-DESIGN.md`
§1; fleet gold shape `WP-N → Lot N.M → task` in `~/src/agent-stats/plan.md`.)

## Step 4 — Assign each todo to EXACTLY ONE WP

Every todo lands in **one** WP, by its **primary** concern.

- **A homeless todo means the taxonomy is wrong** — surface it, never drop it. If an item fits no WP, the WP
  set is missing a concern (or a boundary is mis-drawn). Fix the taxonomy and re-assign; a dropped item is a
  silent loss of work.
- **Genuinely spans two WPs ⇒ SPLIT the item, never multi-home.** If a todo truly serves two concerns,
  propose splitting it into two items (one per WP). An item belongs to one parent; multi-homing breaks the
  `%`-rollup and the single-owner clarity. Splitting is part of the proposal, surfaced for ratification.

## Step 5 — Self-audit the taxonomy (loop before proposing)

Run `assets/clustering-checklist.md`. Do not present a proposal until every item passes; if one fails, fix
the taxonomy and re-run — loop, don't ship. The load-bearing checks:

- **No homeless todos** — every backlog item is assigned, or its homelessness is surfaced as a taxonomy gap.
- **No "misc", no single-ticket WP, no milestone-only name.**
- **4–7 WPs**, each with a one-line charter and a scope boundary naming where the excluded work lives.
- **Owner seams preserved** — record vs render vs logic, referent vs contract, D5 ≠ M5 distinctions intact.
- **Splits, not multi-homes** — any cross-cutting item is proposed as a split, never assigned twice.
- **Concern, not timeline** — no WP is defined by a milestone/date prefix.

## Step 6 — EMIT THE PROPOSAL (the human ratifies)

Build the proposal from `assets/proposal-template.md`. It has two parts:

1. **The WP set** — for each WP: a `sourceKey` slug (non-positional, e.g. `wp:record-integrity`), title,
   one-line charter, scope boundary.
2. **The per-item reparent plan** — a table `item id · title · current parent · → target WP · note`, plus a
   **splits** list and a **surfaced-homeless** list (if any). The plan is the exact set of writes Step 7
   would apply.

Present **prose first** (the WP set + rationale, scannable), **then** one modal-ask to capture the decision
(*approve / revise WP set / defer*). **Never** present a bare option menu. For a **consequential
restructuring** — a large backlog, cross-owner items, or a backlog already structured one way — **compose
`present-decision`**: build its dossier (options = candidate WP cuts, with the strongest case for/against
each) and run its self-audit gate before asking. A first-time structuring of a small flat backlog can use
the lighter quick-ask path; when in doubt, escalate the path.

## Step 7 — Apply ONLY on approval (never auto-write)

**Never write without the human's explicit OK.** On approval, apply the ratified plan via track:

- **Create each WP** as a parent item: `track item new --kind chore --role workpackage --title "<charter>"
  --workspace <w>`. WP-ness comes from `role:'workpackage'` (shipped 0.10.0) — never from `kind`, from
  having children, or from a `sourceKey` marker.
- **Reparent each todo**: `track item reparent <itemId> --parent <wpId>`. (A WP nests only under a WP; a
  leaf may nest under a WP or a leaf.)
- **Apply any splits** as new items first, then reparent each half.
- **Verify with `track report --wp`** — the `%` is rolled up from leaf buckets (`done / active`, `0/0 ⇒
  n/a`), never asserted by hand. This retires hand-maintained `%` tables.

If the human deferred or revised, do not write — fold the revisions into the WP set and re-present. Only
reversible prep (drafting the next proposal) may continue meanwhile.

## DON'T

- **Auto-restructure without ratification** — the proposal is the deliverable; the writes wait for OK.
  (The exact mistake this skill exists to prevent.)
- **Cluster by milestone / date** — `M\d`/`v\d`/`BR-\d`/`Lot` is timeline, not theme.
- **A "misc" WP, a single-ticket WP, or a milestone-only WP name.**
- **Multi-home an item** — split it instead; one item, one parent.
- **Drop a homeless todo** — surface it as a taxonomy gap; never let work vanish.
- **Collapse owner seams** — record vs render vs logic, referent vs contract (D5 ≠ M5) stay distinct.
- **Assert `%` by hand** — let `track report --wp` roll it up from leaves.
- **Impose globally or init/edit another repo or its rules.** Work on the repo you are invoked in; if track
  is absent, *recommend* `track init` — never force it, never touch a foreign entrypoint.

## Per-agent mapping (tool-neutral)

| Capability | Claude | Codex | Gemini-agy |
| --- | --- | --- | --- |
| skill entrypoint | `~/.claude/skills/propose-workpackages/SKILL.md` | `~/.codex/skills/propose-workpackages/SKILL.md` (project entry `AGENTS.md`) | `~/.gemini/commands/propose-workpackages.toml` (project entry `GEMINI.md`) |
| modal-ask tool | `AskUserQuestion` | a numbered prose Q/R | a numbered prose Q/R |
| code-search tool | Grep / Glob / Read | ripgrep / read | ripgrep / read |
| second-opinion tool | sub-agent / `codex` + `opus` CLIs | `opus` CLI | second-model CLI |
| decision presenter | compose `present-decision` | compose `present-decision` | compose `present-decision` |

`AGENTS.md` is the canonical entrypoint; `CLAUDE.md` / `GEMINI.md` point back to it. Existing repo methods
win on conflict.
