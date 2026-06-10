# Workpackage proposal — <repo / backlog name>

> Present this **prose first** (the WP set + rationale), **then** one modal-ask to capture the decision
> (approve / revise / defer). Nothing is written until the human approves. For a consequential
> restructuring, build this inside a `present-decision` dossier and run its self-audit gate first.
> Run `clustering-checklist.md` before presenting.

## 1. The workpackage set (4–7 perennial WPs)

| sourceKey | title | charter (one line) | boundary — NOT here (→ where) |
|-----------|-------|--------------------|-------------------------------|
| `wp:<slug>` | <WP title> | <the durable concern this WP owns> | <what's excluded → neighbouring WP> |
| `wp:<slug>` | | | |
| `wp:<slug>` | | | |
| `wp:<slug>` | | | |

> `sourceKey` is a **non-positional** slug (`wp:record-integrity`), never `WP1` (that ordinal is a derived
> display label, not stored identity). WP-ness = `role:'workpackage'` on a `kind:'chore'` parent item.

## 2. Per-item reparent plan

| item id | title | current parent | → target WP | note |
|---------|-------|----------------|-------------|------|
| <id> | <title> | <none / id> | `wp:<slug>` | |
| <id> | <title> | | `wp:<slug>` | |

(One row per backlog item. Every item appears exactly once. This table IS the set of writes Step 7 applies.)

### Splits (items that genuinely span two concerns)

| original item id | title | → split into (per WP) | rationale |
|------------------|-------|-----------------------|-----------|
| <id> | <title> | `wp:<a>` half + `wp:<b>` half | <why one item can't hold both concerns> |

(Empty if no item spans two WPs. Splitting is part of the proposal — surfaced for ratification, not done silently.)

### Surfaced homeless items (taxonomy gaps)

| item id | title | why it fits no WP | proposed fix |
|---------|-------|-------------------|--------------|
| <id> | <title> | <the missing concern / mis-drawn boundary> | <new WP / boundary change> |

(Empty if the taxonomy is complete. A homeless item is NEVER dropped — it is a signal the WP set is wrong.)

## 3. Rationale (scannable)

- **Why these concerns**: <the durable seams the cut follows — owning artifacts, owner-level distinctions>.
- **What was de-milestoned**: <milestone-tagged items remapped to their concern, and from which prefix>.
- **Owner seams kept distinct**: <record vs render vs logic; referent vs contract>.

## 4. The decision asked

Approve this WP set + reparent plan? Options: **approve** (apply via `track item new --role workpackage` +
`track item reparent`) · **revise** (<which WP / boundary to change>) · **defer**.

> On **approve**: create each WP, reparent each item, apply splits, then `track report --wp` to verify the
> rolled-up `%`. On **revise/defer**: do not write — fold the change and re-present.
