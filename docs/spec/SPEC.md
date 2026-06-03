# SPEC — `@sentropic/track` (MVP)

> Derived from `INTENTION.md`. Closes the 9 pinned refinements **and** the SPEC double-review (Opus 4.8 + Codex gpt-5.5 xhigh — archives `docs/reviews/spec-r1-*.md`).
> Scope: the **h2a-free, single-writer MVP** — `docs-git` backend, append-only event log, `validate`/`query`/`report`, `BRANCH.md` import/annotate (BRANCH.md stays master), single host via CLI. Everything else is v2+ (see `INTENTION.md`).
> **Concurrency:** the MVP is **single-writer** (one agent appends at a time per repo). Concurrent multi-agent merge is **v2+**, delegated to h2a coordination/lease-lock — consistent with boundary A.

## 1. Purpose

`track` is the **system of record** for a typed product backlog and its specification / realization / acceptance state. It records; it does not execute work or coordinate agents. The MVP makes the existing `BRANCH.md`-driven flow **queryable** without taking ownership from it.

## 2. Domain model

### 2.1 Item
```
Item {
  id: Ulid                       // minted once
  sourceKey?: string             // stable external key (e.g. BRANCH import) for idempotent re-resolution
  kind: "feature" | "bug" | "chore" | "decision"
  title: string
  body?: string                  // prose; may live in markdown (see §4)
  workspace: string
  parentId?: ItemId
  links?: Link[]
  engagementRef?: string         // h2a ENGAGEMENT (execution; v2+)
  taskRef?: string               // coordinate Task (execution; v2+)
}
```
Non-decision Items carry three orthogonal axes (§2.2–2.4). `kind:"decision"` is specialized (§2.5).

### 2.2 Axis 1 — Specification
`specStatus: "to-specify" | "specified"` — monotone, pure definition. `to-specify → specified` allowed once; reverse rejected. **`n/a` for `kind:"decision"`.**

### 2.3 Axis 2 — Realization
`realization: "to-do" | "in-progress" | "done" | "cancelled" | "rejected"`.
- Forward: `to-do → in-progress → done`. Legal transitions only; illegal rejected at append.
- `cancelled` = actor-initiated withdrawal (from `to-do`/`in-progress`). `rejected` = consequence of a `no-go` decision (§2.6), emitted with `cause:{decisionId}`.
- Detailed execution is out of track (`engagementRef`/`taskRef`).

### 2.4 Axis 3 — Acceptance (computed, revocable) — total function
```
AcceptanceCriterion { id, itemId, statement }
TestEvidence  { id, criterionId, kind:"unit"|"integration"|"e2e"|"manual", locator }
TestRun       { evidenceId, commit, env, runner, result:"pass"|"fail", at }
Waiver        { criterionId, reason, by, at }     // an EXCEPTION, not a test result
```
**`baselineCommit`** (the notion of "current") is supplied to `report`/`validate` (`--commit`, default = repo git HEAD).

**criterionStatus(c)** — ordered cascade over c's evidence (latest `TestRun` per evidence):
1. `fail`    if any evidence's latest run = `fail`  *(a live fail overrides a waiver)*;
2. `waived`  else if c has a `Waiver`;
3. `unknown` else if any evidence has no run;
4. `stale`   else if any evidence's latest run `commit ≠ baselineCommit`;
5. `pass`    else (all evidence latest = `pass` at baseline).

**acceptanceStatus(item)** — ordered cascade over its criteria:
`fail` if any criterion `fail` → else `unknown` if any `unknown` → else `stale` if any `stale` → else `waived` if any `waived` → else `pass`.
Zero criteria ⇒ `unknown`. **`n/a` for `kind:"decision"`.** Revocable: a new `fail` run regresses. `done` (realization) ≠ `pass` (acceptance).

### 2.5 Decision (specialized Item) — pins 1,2,3
```
Decision (kind:"decision") {
  decisionKind: "orientation" | "commitment"
  targets: ItemId[]                          // non-decision Items ONLY
  outcome: "pending" | "go" | "no-go" | "deferred"
  dossier: Dossier                            // §2.7
}
```
- **Specialized axes:** spec axis & acceptance axis are **`n/a`** (validator forbids `AcceptanceCriterion` on a Decision). A Decision uses **only** realization (its prep work IS its realization) + `outcome`.
- **Completion:** *prepared* when realization=`done`; *settled* only when `outcome ∈ {go,no-go}` — independent.
- **Recursion guard:** `targets` MUST be non-decision Items; a Decision targeting a Decision is rejected (A3).
- **Report:** excluded from default `report` (`--decisions` to include) — §7.
- **Blocker on creation:** `decision.created` MUST emit one `blocker.opened` (kind:`decision`) **per target** (else AWAITED cannot hold).

### 2.6 `outcome` machine + target effect — pin 4
Legal `outcome` transitions: `pending → {go, no-go, deferred}`; `deferred → {go, no-go}`. `go`/`no-go` are **terminal**. Re-deciding appends a new `decision.outcome` event that supersedes the prior (append-only; the fold takes the latest legal one); a transition out of a terminal outcome is rejected.
Effect, emitted **atomically** as one command batch (§3):
- `go`       → `blocker.resolved` for each target's decision blocker.
- `no-go`    → `blocker.resolved` + `realization.transition → rejected` (`cause:{decisionId}`) per target.
- `deferred` → **nothing** (blocker stays open → target AWAITED). Resolution keys on `outcome ∈ {go,no-go}`.

### 2.7 Dossier (typed) — pin 6
```
Dossier { context, options: Option[],          // Option { id, title, summary, pros?, cons? }
          qa: QAEntry[],                        // QAEntry { id, question, answer? }  (joined)
          selectedOptionId?, recommendation?:{ optionId, rationale },
          resultingSpecChange?, decisionEvaluation?: PriorityAssessment }  // FROZEN snapshot
```
`outcome` is **not** duplicated here (single source = the Decision).

### 2.8 Prioritization (optional, versioned)
```
PriorityAssessment { itemId, schemeId, schemeVersion, inputs:object, score:number, order?, at }
```
`Item.priority` = latest assessment (live, sort key). `Dossier.decisionEvaluation` = frozen snapshot at decision time. **WSJF** (`schemeId:"wsjf"`): `inputs{ userBusinessValue, timeCriticality, riskReductionOpportunityEnablement, jobSize }`, `score = (userBusinessValue + timeCriticality + riskReductionOpportunityEnablement) / jobSize`. Never hardcoded; used only when active. Other schemes post-MVP (registry `schemeId → {inputSchema, rank}`).

### 2.9 Blocker (relation) — pin 8
```
Blocker { id, targetId, kind:"decision"|"dependency", ref:ItemId, reason, resolutionRule, owner, openedAt, resolvedAt? }
```
- Stored as `blocker.opened`/`blocker.resolved` events; the open set is **computed** by fold.
- `decision` → `ref` is a Decision; resolves **only** when that Decision's `outcome ∈ {go,no-go}`. **Manual `blocker resolve` on a `decision` blocker is rejected** by the validator (single source).
- `dependency` → `ref` is an Item; `resolutionRule ∈ {"linked-done"|"linked-accepted"|"manual"}` (default `linked-done`); auto-resolves when the rule is met; `manual` allows `blocker resolve`.
- h2a relationship: reuse h2a's `raise/list/resolve` mechanism shape when present (v2+); track owns the product-item semantics. MVP = local.

### 2.10 Gate disposition — pin 5
Each Item records, per gate, a disposition (so skipping is queryable):
`disposition[gate:"orientation"|"commitment"] = "required"|"skipped"|"not-applicable"|"completed"`.
- Default at creation: orientation `required`, commitment `required`.
- Set via `decision.disposition` events `{itemId, gate, disposition, decisionId?, reason?, by, at}`.
- `completed` is set automatically when a Decision of that gate (`decisionKind` = gate) targeting the Item settles (`outcome ∈ {go,no-go}`); the latest settled decision of the gate wins. `skipped`/`not-applicable` are explicit, never inferred from absence.

## 3. Event contract (append-only, single-writer) — pin 7
Single append stream `​.track/events.jsonl`. Frame:
```
{ id:Ulid, type, aggregate:"item"|"decision"|"blocker", aggregateId,
  seq:int,                 // per-aggregate monotonic (transition-legality authority — NOT wall-clock)
  prevHash:"sha256:…"|null,// = contentHash of the immediately preceding stream event
  cmdId?:Ulid,             // correlates events emitted by one command (atomic batch)
  at:ISO(ms), by:ActorId, payload:object,
  contentHash:"sha256:…" } // = sha256(canonicalJSON(payload)) — PAYLOAD ONLY (excludes seq/prevHash/contentHash)
```
**Integrity (`validate`)** — for each event in stream order: (i) recompute `contentHash` from `payload` (tamper of content), (ii) `prevHash === previous event.contentHash` (insertion/reorder), (iii) per-aggregate `seq` strictly increasing (drop/dup). This is the h2a journal model (`computeHash(payload)` + positional `prevHash`/`sequence` chain), faithfully reused.
**Fold** — replay in stream order; per-aggregate state = fold of its events by `seq`; transition legality checked at append against current folded state. `at` is informational only (ULID-millisecond, consistent with `id`); ordering authority is stream position + per-aggregate `seq`.
**Atomic commands** — a command that emits several events (e.g. decision `no-go` → `decision.outcome` + `blocker.resolved` + `realization.transition`) writes them as one contiguous batch sharing `cmdId`, appended all-or-nothing. `validate` flags a partial batch (a `cmdId` missing an expected member) for repair.
**Concurrency** — single-writer in MVP; multi-writer merge = v2+ (h2a lease-lock). No "re-chain on read", no `(at,id)` sort.

Event types: `item.created` · `spec.transition` · `realization.transition`(`cause?`) · `acceptance.criterion.added` · `acceptance.evidence.linked` · `acceptance.run` · `acceptance.waived` · `blocker.opened` · `blocker.resolved` · `decision.created` · `decision.disposition` · `dossier.revised` · `decision.outcome` · `priority.assessed` · `branch.imported`.

## 4. Persistence layout (docs-git)
```
<repo>/.track/events.jsonl        # append-only source of truth (structure)
<repo>/.track/snapshots/<seq>.json# rebuildable fold caches (never authoritative)
docs/…                            # long prose (spec bodies, dossier context) in markdown
```
Structure lives in the log; long prose in markdown referenced by `body`/`Dossier.context`. **Round-trip / desync rule (`validate`):** a referenced markdown file MUST exist and its H1 title MUST match the Item `title`; mismatch or missing file = a desync finding (MVP reports, does not auto-repair).

## 5. BRANCH.md integration — pin 9
`track branch import <BRANCH.md>`:
- **Reads** the file; parses the stable `BRANCH_TEMPLATE` sections: `# Feature: <Title>` (→ one parent `feature` Item), `## Objective`/`## Scope` (→ body), `## Plan / Todo (lot-based)` `- [ ] **Lot N — <slug>**` (→ one `chore` Item per lot, parented), and UAT checkboxes **nested inside each lot** (→ `AcceptanceCriterion` on the lot Item). Gate sub-checkboxes are **ignored** in MVP.
- **Identity:** each derived Item has a fresh `id:Ulid` and a stable `sourceKey = "<branchSlug>/<lotSlug|uatSlug>"` (`branchSlug` from the `BR-ID`/filename; `lotSlug` from the lot **title**, never its index). Re-import resolves by `sourceKey`, diffs fields, emits **only deltas** (idempotent; survives lot reordering).
- **Checkbox → state mapping:** lot `[x]` → `realization.transition → done`; lot `[ ]` → `to-do`. UAT `[x]` → an `acceptance.run{kind:"manual", result:"pass"}`; UAT `[ ]` → criterion with no run (`unknown`).
- **Read-only:** never writes `BRANCH.md` (owned by `lot-gate`/`branch-close`). Annotations live only in `.track/`. Each derived Item carries `links:[{kind:"branch.md", locator}]` and a `branch.imported` provenance event.

## 6. CLI surface (MVP)
JSON-first (`--format json|text|md`). `init` · `item new|spec|realize|show|ls` · `decision new|dossier|outcome|disposition` · `blocker raise|resolve` · `accept criterion|link|run|waive` · `priority assess` · `report [--decisions]` · `query` · `validate` · `branch import`. (Signatures per §2/§5.)

## 7. `report` semantics
Iterates Items where `kind != "decision"` (unless `--decisions`). Buckets, first match wins:
1. **AWAITED** — any open blocker (`decision`/`dependency`).
2. **DROPPED** — realization ∈ {`cancelled`,`rejected`}.
3. **DONE** — realization=`done` (**and** acceptanceStatus=`pass` iff `report.requireAccepted=true`; named toggle, default `false`).
4. **TO-DO** — otherwise.
Sorted by the active prioritization scheme when present. `--decisions` lists Decisions by realization + `outcome`.

## 8. Acceptance criteria (the MVP's own UAT)
- **A1** `branch import` on a real `sentropic/plan/NN-BRANCH_*.md` derives Items and leaves the `BRANCH.md` byte-hash **unchanged**; re-import emits only deltas (idempotent under lot reordering).
- **A2** `report` buckets a fixture across all four buckets incl. a `no-go` Decision driving its target to DROPPED and an `in-progress` item with an open dependency showing AWAITED.
- **A3** validator rejects: reverse spec transition; Decision→Decision target; illegal realization transition; `AcceptanceCriterion` on a Decision; manual resolve of a `decision` blocker; outcome transition out of a terminal `go`/`no-go`.
- **A4** integrity: a tampered `payload` (contentHash mismatch) **or** a reordered/inserted line (prevHash/seq break) is detected by `validate`.
- **A5** `deferred` leaves target AWAITED; `go` resolves it; `no-go` resolves it + DROPS the target — emitted as one atomic `cmdId` batch; a partial batch is flagged.
- **A6** a regressing `fail` run overrides a prior `waived` (criterionStatus=`fail`); `stale` computed against `baselineCommit`.
- **A7** `decision.created` opens one `decision` blocker per target; the target shows AWAITED until the decision settles.

## 9. Non-goals (MVP)
External backends; MCP; multi-host plugins; llm-mesh/coherence; multi-repo consolidation; **concurrent multi-writer merge**; UI screens; binding decisions via h2a negotiation; scheme registry beyond WSJF; prose↔log auto-repair; making `scope-check`/`lot-gate` *consume* track (track only exposes the read interface — wiring those skills is v1.1).

## 10. Deferred open items
Multi-writer merge + h2a lease-lock; CI→`acceptance.run` push (MVP ingests a report file via `accept run --from`); dependency `resolutionRule` beyond `linked-done`; `report.requireAccepted` per-workspace config; desync auto-repair; gate sub-checkbox semantics in BRANCH import.
