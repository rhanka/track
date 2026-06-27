---
name: present-decision
description: Use when an agent must present a complex, irreversible, cross-owner, security/contract-affecting, costly, or genuinely balanced decision to a human owner — or must choose between decide-and-trace, a quick ask, and a full decision dossier. The agent presents at the level of the stakes, never sells its preferred option, and records the decision in track. This is agent→human; it is NOT h2a (h2a ATTENTION is the inter-agent presenter).
---

# Present Decision

Present human decisions **at the level of the stakes**. Do not sell your preferred option. Do not outsource this to h2a — h2a ATTENTION/MANDATAIRE is the *inter-agent* neutral presenter in a negotiation; this skill is the agent's own *agent→human* working method.

This skill is **tool-neutral**. Where it names a capability ("your code-search tool", "your modal-ask tool", "your second-opinion agent"), use your host's equivalent — see **Per-agent mapping** at the end.

## Step 1 — Calibrate (the trigger scorecard)

Score the decision *before* asking anything. Pick exactly one path.

**Decide + trace** — when ALL are true: local scope, reversible in ≤ one focused work block, no security/privacy/data-loss/frozen-contract/cross-owner impact, an existing repo pattern is clear, and no genuine equipoise. → Decide, state the reversible assumption out loud, keep moving. (Optionally record via track.) **Do not** stage a complaisant menu for a call you can reverse.

**Quick ask** — when exactly one owner preference is missing, there are 2–3 clear options, rollback is cheap, and no hard trigger below applies. → Use your modal-ask tool with one-sentence impact per option.

**Full dossier** — when ANY hard trigger applies:
- irreversible, or rollback > one focused work block
- public / frozen contract; event / read / write schema
- auth / security / privacy / IAM
- migration / data retention
- cross-repo / cross-owner / cross-agent
- meaningful cost / timeline / workpackage impact; high blast radius
- strong reviewer disagreement; genuine equipoise
- unknown owner validation criteria that could change the outcome
- the owner asks for validation at stake level

Two *medium* triggers (moderate cost, partial reversibility, one repo but a shared module, mild reviewer disagreement) also mean **dossier**. When in doubt, escalate the path, not the ceremony — a dossier can be short, but it must be honest.

## Step 2 — Gather inputs (full-dossier path)

1. **Local context first.** User request; repo entrypoints (`AGENTS.md`, then the host-specific pointer); applicable repo rules; existing track state when `.track/` exists; and **`track report`** (default table: fait / à-faire %·WP / attendus) when track is available. Use your code-search tool to ground claims in the actual code, not memory.
2. **The double-instruction (standing rule).** For a complex *design* decision, get **independent Codex + Opus passes** via your second-opinion tool before recommending. **Synthesize — do not blend away disagreements.** If a hard-trigger decision lacks the second pass, mark the dossier **Incomplete** and ask whether to wait or proceed provisionally; only reversible prep may continue meanwhile.
3. **Owner criteria.** Seed from `assets/owner-criteria.template.md`; source the live criteria from the request, repo rules, prior owner decisions, existing track decisions/dossiers, and the `track report` attendus.

## Step 3 — Build the 8-section dossier

Use `assets/dossier-template.md`. In order, no ornamental sections:

1. **Decision asked** — one sentence, option IDs, exact scope.
2. **Context** — facts, assumptions, and unknowns kept separate.
3. **Stakes** — why this is dossier-level; affected repos / WPs / contracts / users.
4. **Options** — table: `id · choice · strongest case FOR · strongest case AGAINST · cost · reversibility · what would make it win`. One row per option, including rejected ones.
5. **Recommendation + rationale** — one recommended option (or "defer"), with the decisive judgment.
6. **Reversibility / cost** — rollback path, sunk cost, migration / cleanup cost, time estimate.
7. **Attendus** (the human's validation criteria) — checklist `criterion · source · covered by · gap`.
8. **What I need from you** — the smallest valid decision or the one missing criterion.

## Step 4 — SELF-AUDIT GATE (loop before presenting)

Run `assets/self-audit.md` as a checklist. **Do not present a dossier as complete until every item passes.** If any item fails, fix the dossier and re-run the gate — loop, don't ship.

- **FACT / JUDGMENT tags** — every load-bearing claim is tagged `[FACT]` (verifiable, with a source) or `[JUDGMENT]` (your read). No untagged assertions.
- **Count-symmetry on pros** — each option has roughly as many genuine "case FOR" points as the others; you have not starved alternatives to flatter your pick. Steelman every option, including rejected ones.
- **Strongest case AGAINST my recommendation** — a required, non-empty section. Make it the best version, not a strawman.
- **What would overturn it** — what would have to be true for the owner to reject your recommendation.
- **Pre-mortem** — one paragraph: "six months later this failed because…".
- **Agent-interest disclosure** — name what is easiest / faster / less risky *for you, the presenter*, and flag any place the recommendation benefits you more than the owner. State the owner interest (value, integrity, risk, future optionality, cost) separately.

If any item cannot be honestly completed, label the dossier **Incomplete** and ask for the missing fact/criterion — never ask for validation of an incomplete dossier.

## Step 5 — Present, then capture the choice

- **Decide + trace:** no question — state the assumption and proceed.
- **Quick ask:** your modal-ask tool is the right surface.
- **Full dossier:** present the dossier as **prose first**, scannable. **Then** end with ONE modal-ask whose options carry IDs (e.g. *approve recommendation / choose B / defer*) to capture the decision. **Never present a chip/option menu alone for a complex decision** — prose then a final ask, not a bare menu.

## Step 6 — Record in track

Record when `.track/` exists or the owner approves tracking. **Never fabricate evidence.**

- Use `track decision dossier <decisionId> --context <c>` for structured dossier prep.
- After presentation/validation, append artifact evidence with **`track decision add-artifact`** — never rewrite the whole dossier just to append:
  - **h2a negotiation dossier:** `--kind h2a-decision-dossier --negotiation-ref <n> --dossier-hash <h>` — only with a *real* negotiationRef + dossierHash (and real comprehension evidence recorded via the h2a/ingest seam, never minted here).
  - **agent↔human text/view dossier** (before a DS renderer exists): `--kind rendered-view --view-ref <stable-id> [--source-dossier-hash <h>]`.
- **Do NOT fake `comprehension[]`.** A chat reply is validation *context*, not a signed h2a attestation. The CLI does not let you mint one — and you must not.
- **Do NOT record the bridge/relay principal as the human decider.** The attester (who comprehended) is distinct from the channel that relayed the write.

## DON'T

- A 4-option chip menu on an irreversible / cross-repo / security / frozen-contract call (the exact mistake this skill exists to prevent).
- "Which do you prefer?" with no stakes, costs, recommendation, or attendus.
- Selling the preferred option by weakening alternatives.
- False neutrality when you should just decide a reversible choice.
- Hiding presenter convenience as owner value.
- Faking `comprehension[]`, or recording a bridge principal as the decider.
- Initializing or editing another repo, global rules, or entrypoints without explicit owner approval. When invoked in a repo, insert gracefully into that repo's existing methods and *recommend* tracking via track — never impose a global standard.

## Per-agent mapping (tool-neutral)

| Capability | Claude | Codex | Gemini-agy |
| --- | --- | --- | --- |
| skill entrypoint | `~/.claude/skills/present-decision/SKILL.md` | `~/.codex/skills/present-decision/SKILL.md` (project entry `AGENTS.md`) | `~/.gemini/commands/present-decision.toml` (project entry `GEMINI.md`) |
| modal-ask tool | `AskUserQuestion` | a numbered prose Q/R | a numbered prose Q/R |
| code-search tool | Grep / Glob / Read | ripgrep / read | ripgrep / read |
| second-opinion tool | sub-agent / `codex` + `opus` CLIs | `opus` CLI | second-model CLI |

`AGENTS.md` is the canonical entrypoint; `CLAUDE.md` / `GEMINI.md` point back to it. Existing repo methods win on conflict.
