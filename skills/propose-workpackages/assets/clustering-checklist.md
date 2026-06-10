# CLUSTERING CHECKLIST — run before emitting any workpackage proposal

Loop: run the checklist → if any item fails, FIX the taxonomy → re-run. Do not propose until every box is
checked. A failing check is a defect in the WP set, not a reason to ship anyway.

## Checklist

- [ ] **Read from data** — the backlog came from `track report --format json` (+ `track query` / `item show`
      for `parentId`), not from memory. Every item is accounted for.
- [ ] **Concern, not timeline** — no WP is defined by an `M\d`/`v\d`/`BR-\d`/`Lot`/sprint prefix. Milestone
      items were mapped to the concern they advance.
- [ ] **4–7 workpackages** — the set is small enough to pilot and large enough to separate concerns.
- [ ] **Charter + boundary each** — every WP has a one-line charter AND an explicit "NOT here (→ which WP)"
      boundary. No WP is a bare title.
- [ ] **No catch-all** — no "misc" / "other" / "general" WP. A would-be catch-all means a concern is missing.
- [ ] **No single-ticket WP** — no WP exists to hold exactly one todo.
- [ ] **No milestone-only name** — every WP is named for an owning artifact/concern, not a date or release.
- [ ] **Exactly one WP per todo** — every item is assigned to one parent by its primary concern.
- [ ] **No homeless todo** — every item fits a WP, or its homelessness is surfaced as a taxonomy gap (never
      dropped, never hidden).
- [ ] **Splits, not multi-homes** — any item that genuinely spans two concerns is proposed as a SPLIT (two
      items), not assigned to two WPs.
- [ ] **Owner seams preserved** — record-side vs render vs logic owners are not collapsed; referent vs
      contract distinctions (e.g. D5 mockups ≠ M5 render contract) are intact.
- [ ] **Reparent plan resolves to real ids** — each row names a real `item id` and a real target WP (or a
      WP to be created), so Step 7 can apply it verbatim.

## Red flags — STOP and rebuild the taxonomy

- A WP whose charter is a list of unrelated things ("and also…") — that is two concerns wearing one name.
- An item you assigned "because it was open at the same time" — that is timeline clustering, not concern.
- A WP named after the milestone that happened to surface its items.
- A homeless item quietly parked in the closest-fitting WP instead of surfaced as a gap.
- The same item appearing under two WPs — it must be split, not multi-homed.
- More than 7 WPs, or fewer than 4 — re-cluster before proposing.
