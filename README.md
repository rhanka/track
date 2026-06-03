# @sentropic/track

Typed product-backlog and **spec / realization / acceptance tracking** for the sentropic ecosystem — a **record-only system of record** with an append-only, integrity-checked event log.

> **Status:** MVP implemented (Lots 0–7). `docs-git` backend · single-writer · CLI. h2a coordination, external backends, MCP, multi-writer merge and UI are v2+ (see [`INTENTION.md`](./INTENTION.md), SPEC §9).

## Model (one line)

An **Item** carries three orthogonal axes — **specification** (`to-specify → specified`), **realization** (`to-do → in-progress → done | cancelled | rejected`), **acceptance** (computed `pass/fail/unknown/stale/waived`) — plus **blockers** (relations), **prioritization** (versioned, WSJF), and first-class linked **Decisions** (orientation/commitment, with a typed dossier + go/no-go `outcome`). `report` projects done / to-do / awaited / dropped. See [`docs/spec/SPEC.md`](./docs/spec/SPEC.md).

## Install & build

```bash
npm install
npm run build      # tsc → dist/ ; bin: `track` → dist/cli/index.js
npm test           # vitest
```

## CLI

State lives in `.track/events.jsonl` (append-only) in the current directory.

```bash
track init

# items
track item new --kind feature --title "Login" --workspace web [--body <md-path>] [--parent <id>]
track item spec     <itemId> specified
track item realize  <itemId> in-progress|done|cancelled
track item show     <itemId>
track item ls       [--workspace <w>] [--kind <k>] [--format json|text|md]

# decisions (orientation / commitment) — open a decision blocker per target until it settles
track decision new       --kind orientation --title "DB?" --workspace web --targets <id,id> [--context <c>]
track decision outcome   <decisionId> go|no-go|deferred       # no-go drops non-terminal targets
track decision dossier   <decisionId> --context <c>
track decision disposition <itemId> orientation|commitment required|skipped|not-applicable

# blockers
track blocker raise   --target <id> --kind dependency --ref <id> [--rule linked-done|manual] [--reason <r>]
track blocker resolve <blockerId>                              # only a `manual` dependency blocker

# acceptance (criteria → evidence → runs / waivers; status is computed vs --commit)
track accept criterion <itemId> --statement "user can log in"
track accept link      <criterionId> --kind unit|integration|e2e|manual --locator <id>
track accept run       <evidenceId> --result pass|fail [--commit <sha>] [--env <e>] [--runner <r>]
track accept run       --from junit.xml --format junit [--commit <sha>]     # ingest a report
track accept waive     <criterionId> --reason "<why>"

# prioritization (WSJF = (UBV + TC + RR/OE) / jobSize)
track priority assess <itemId> --ubv 8 --tc 4 --rr 2 --js 2

# views
track report [--decisions] [--require-accepted] [--format json|text|md] [--commit <sha>]
track query  [--kind <k>] [--workspace <w>] [--bucket AWAITED|DROPPED|DONE|TO-DO] [--realization <r>] [--acceptance <a>] [--format <f>]

# integrity + prose↔log desync (§4); never repairs, only reports
track validate [--commit <sha>]

# BRANCH.md → track sidecar (read-only; idempotent; BRANCH.md stays the source of truth)
track branch import <plan/NN-BRANCH_*.md> [--commit <sha>]
```

`report` buckets (first match wins): **AWAITED** (any open blocker) › **DROPPED** (cancelled/rejected) › **DONE** (done, and `pass` if `--require-accepted`) › **TO-DO**. `--commit` defaults to the repo git HEAD.

## Integrity

The event log is **append-only**; each event carries `contentHash = sha256(canonicalize(core))` and a positional `prevHash` chain + per-aggregate `seq` (faithful to the h2a journal). `track validate` recomputes the chain, the per-aggregate sequence, atomic-batch completeness, and a `head.json` truncation anchor. The contract was frozen after multi-round adversarial review — see [`docs/reviews/lot1-FROZEN.md`](./docs/reviews/lot1-FROZEN.md).

## Library

```ts
import { Track, EventStore } from '@sentropic/track'
const track = new Track(new EventStore('.track/events.jsonl'))
const id = track.createItem({ kind: 'feature', title: 'Login', workspace: 'web' })
track.setRealization(id, 'in-progress')
console.log(track.report({ baselineCommit: 'HEAD' }).buckets)
```

See [`INTENTION.md`](./INTENTION.md) for the full model, boundaries, and rationale; [`docs/plan/PLAN.md`](./docs/plan/PLAN.md) for the build lots; [`docs/reviews/`](./docs/reviews) for the per-lot double reviews.
