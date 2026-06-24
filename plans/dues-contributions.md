# Member contributions / dues / requirements

> Living plan. Plan path: `plans/dues-contributions.md`. Read first.

## Goal

A **standardized skeleton** for recording what members owe/contribute (dues,
payments, work, donations) where the **per-camp details are configurable and
versioned per year**. Some camps have no dues at all; others have several named
tiers with different requirement levels. Changing a camp's setup in a new year
must NOT alter old years' data.

## Decisions already made (don't re-litigate)

- **User picked option D**: this is a membership/**requirements** model; the
  finances ledger (`finance_entry`, donations in / spends out) is just one view.
- **The skeleton is standardized; the per-camp specifics are config.** "Some
  camps don't do dues at all" → a camp with zero configured tiers simply has an
  empty, unused feature.
- **Versioned per edition (year), with carry-forward defaults.** Tiers/levels
  live per `(camp_id, edition_id)`. A new year is seeded by an explicit "copy from
  <year>" action (no destructive auto-rewrite). Editing one year never touches
  another → old datasets stay intact.
- **Records snapshot their values.** A member's requirement references the
  edition's tier (which is immutable history once that year is locked/past), and
  money records (`finance_entry`) already store amounts; so config edits never
  rewrite history.
- **Officer-only**, like finances. Not shown to all campers (a later, optional
  slice could show a member their own status).
- **Whole feature hideable per camp.** `camp.tracksDues` (default **false**) gates
  the Dues nav link AND the route (loader redirects to /finances when off). Camps
  with no dues never see it. Officers turn it on with a checkbox on the Finances
  page (a camp-level setting, allowed even when the year is locked). Migration 0029.

## Data model

- **`contribution_tier`** (edition-scoped config) — the camp's named tiers for a
  year: `name`, `expectedCents` (nullable; null = not a fixed $), `requirement`
  ("required" | "suggested" | "optional"), `description`, `sortOrder`. Camps with
  no dues define none.
- **`member_requirement`** (edition-scoped, slice 2) — per membership per edition:
  `tierId` (nullable ref), `expectedCentsOverride` (nullable), `waived` (bool),
  `notes`. Unique on `(editionId, membershipId)`. "Paid" is derived = sum of that
  member's `finance_entry` donations for the edition. Outstanding = expected −
  paid.
- Money stays in **`finance_entry`** (already exists): a member's dues payment is
  a `donation` with `memberId` set. (Optionally add a `tierId` link later.)

## Slices

1. [ ] **Tier config, versioned per edition.** `contribution_tier` table +
   migration; officer-only `/dues` page: list/add/edit/delete this year's tiers +
   "copy tiers from <year>"; read-only when locked. ← FIRST
2. [x] **Member roster + assignment (LANDED).** `member_requirement` table
   (migration 0028, unique per edition+member); the /dues page now lists every
   member with a tier Select + Waive checkbox, and shows expected (from tier) vs
   paid (sum of their donations) vs outstanding, with a per-year totals line.
   Assignments upsert via onConflictDoUpdate. (Override amount + per-tier payment
   links deferred to slice 3.)
3. [ ] Polish: link a donation to a tier; member-visible own-status; CSV export;
   non-money requirements (work hours) if wanted.

## Notes / gotchas
- Reuse the editions copy pattern (`copyEditionContents` in `editions.tsx`) style
  for "copy tiers from a year", but as an explicit action on the /dues page.
- Don't auto-seed on edition create (keeps it non-destructive + simple); copy is
  opt-in.
