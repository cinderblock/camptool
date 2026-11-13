# Season 2027: BM2027 and an UnSCruz event layer

> Task plan. Parent plan: `plans/camptool.md`. Plan path: `plans/season-2027.md`

## Goal

1. Get Math Camp's app ready for the **Burning Man 2027** season.
2. Make **UnSCruz** a usable event for any camp on CampTool, even though Math
   Camp probably isn't going to UnSCruz 2027.

## What exists today (found 2026-11-13)

- A camp's year is a `camp_edition` row with an `event` column (`burning-man`,
  `unscruz`, `other`, from `app/lib/events.ts`). New years are made on
  `/editions`, optionally copied from an earlier year.
- **One edition per (camp, year).** `camp_edition_camp_year` is a unique index
  (`db/schema/camp.ts`). A camp **cannot** have both BM 2027 and UnSCruz 2027.
  That contradicts the four-layer design ("a camp can attend multiple events").
- **Every season date is Burning Man's.** `weeksUntilEvent(year)` and
  `eventStartFor(year)` in `app/lib/brc.ts` compute BRC gate-open (the Sunday
  8 days before Labor Day) and take no event. The wizard, the dashboard to-do
  list, the guide and `/start` all call it with only the year. An UnSCruz
  edition would schedule its asks around late August, not late April.
- `CURRENT_EVENT_YEAR = new Date().getFullYear()`: in November it still says
  2026, though the 2026 season is over. It is only a default (new-year picker,
  map lot year, sun-sim year), so it is cosmetic, but it rolls over at
  the wrong time.
- BRC 2027 street names and geometry: not loaded. `STREET_NAMES_BY_YEAR` has
  2026 names; geometry falls back to 2025. BMorg publishes the theme first,
  then the street names, then the measurements, months apart.
- UnSCruz has only a label. No vocabulary, no dates, no map provider.
  UnSCruz 2026 ("Absurdia") ran April 30 to May 3. No 2027 dates were published
  as of 2026-11-13.

## Decisions already made (don't re-ask)

1. **No hard cutoff for 2026.** The "current event year" just rolls over
   after exodus; nothing gets locked or cut off. (Cameron, 2026-11-13.)
2. **Cameron starts the 2027 year himself** on `/editions`. Nothing else is
   needed for BM2027 right now. (Cameron.)
3. **UnSCruz is a general offering, later.** Not for a particular camp.
   Their maps are irregular, so no fixed address scheme. "We'll need to build
   support for other events eventually." (Cameron.)

## Plan / steps

### A. BM2027 (Math Camp)

1. [ ] **Data, done in the app by Cameron:** create the 2027 edition on
   `/editions`, copying from 2026. Not a code change.
2. [x] Season rollover: `currentEventYear()` is the next Burning Man that
   hasn't ended (`f08991d`, on master).
3. [ ] 2027 street names, once BMorg publishes them; 2027 geometry once
   measured.

### B. Event layer: dates per event (needed by UnSCruz and by any non-BM camp)

*Deferred ("eventually"). Not started.*

1. [ ] Season dates come from the edition, not from BRC. Proposal: nullable
   `starts_on` / `ends_on` on `camp_edition`, defaulted from the event
   (BM: the computed BRC dates; UnSCruz and others: the officer enters them).
   `weeksUntilEvent(edition)` replaces `weeksUntilEvent(year)`.
2. [ ] Allow several editions per camp per year: unique on
   `(camp_id, year, event)` instead of `(camp_id, year)`. The header year
   switcher becomes an edition switcher ("2027 · UnSCruz").

### C. UnSCruz event layer

1. [ ] Vocabulary and defaults (banned kinds, feature names) if UnSCruz has
   its own terms. **Open question 2.**
2. [ ] Map: UnSCruz is at a fairground with assigned plots, not an annular
   street grid. A plain lot (no address scheme) may be all it needs. Decision
   #6 in the main plan says no speculative second address scheme.

## Open questions for the user

None. B and C wait until other events are picked up.

## Progress log

- [x] 2026-11-13: surveyed the event layer and edition model (above).
- [x] 2026-11-13: rollover shipped to master (`f08991d`).
