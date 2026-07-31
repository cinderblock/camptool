# Programming — public offerings the camp gives to the event

> Living plan. Plan path: `plans/programming-offerings.md`
> Parent plan: `plans/camptool.md`. Sibling: `plans/events-scheduling.md`.

## Goal

Let a camp organize the **things it offers to the wider event** — Math Camp's
lectures, another camp's workshops, classes, performances, or discussions —
from open call through officer curation to a published public lineup.

Origin: Cameron wanted a tool for Math Camp's lectures, and asked whether it
should be a custom camp tool or a generic plugin every camp could use. **It's
generic.** Nearly every theme camp offers *something* to the event; "lecture" is
just Math Camp's flavor of it. So it ships as a core CampTool feature with a
per-offering `kind`, not as camp-theme code.

## Decisions already made (locked by Cameron — don't re-ask)

1. **Audience = public, the whole event.** Not a camp-internal series. This is
   the camp's gift to the event: strangers wander in. Consequence: there is a
   **public, unauthenticated page**, and per-attendee signup/RSVP is out of scope
   (the public has no accounts). Headcount is managed with `capacity` as
   information only, not a booking system.
2. **Intake = open call → officer curation.** A camper proposes ("I want to give
   a 45-minute talk on X"); officers accept/decline, then place accepted
   offerings into dated sessions. This is the hard part of the problem — you must
   collect offerings *before* you know the schedule — so the proposal is a
   first-class row that exists with no date.
3. **Its own feature, not an extension of `schedule`.** Reasons: different
   audience (public vs `gathering_signup.membership_id`, a hard FK to
   `membership`), different lifecycle (propose → curate → publish vs
   schedule → staff), and a camp may well want lectures without work-party
   scheduling. Some server-lib patterns get copied from `schedule.server.ts`;
   no tables are shared.
4. **Scope is presenters, not logistics.** Cameron picked presenter +
   co-presenters and explicitly did **not** pick venue/A-V needs, official-guide
   export, or presenter reminders. Those are deferred (see "Deliberately out of
   scope"), and the schema leaves room without building them.

## Naming

- **Feature key / route: `programming`.** Label "Programming".
- **Entity: `offering`.** NOT `event` — `event` is reserved for the event layer
  (Burning Man vs UnSCruz) per `plans/events-scheduling.md`. Same reason
  `gathering` won for the internal schedule.
- **`offering_session`** is one dated instance (a talk given twice = two
  sessions), mirroring `gathering` → `gathering_occurrence`.
- Camp-specific vocabulary ("Lecture") comes from the per-offering `kind`, not
  from renaming the feature. Math Camp picks `lecture`; a sound camp picks
  `performance`. No camp-theme hook needed.

## Data model

Three tables in `db/schema/programming.ts`, all carrying `camp_id` (the hard
multi-camp invariant) **and** `edition_id` (the per-year scope — a lineup is
per-year by definition). Read-only when the edition is locked.

### `offering` — the proposal, and later the accepted talk

| column | notes |
|---|---|
| `id` | text PK |
| `camp_id` | → `camp.id` cascade, notNull |
| `edition_id` | → `camp_edition.id` cascade |
| `title` | notNull |
| `description` | the public blurb |
| `kind` | soft enum, labels in `app/lib/programming.ts`: `lecture \| workshop \| class \| performance \| discussion \| other` |
| `duration_min` | integer — the proposer's estimate; needed to schedule |
| `status` | `proposed \| accepted \| declined \| withdrawn` |
| `audience` | `public \| camp_only` — lets a camp keep some offerings internal; the public page filters on it |
| `capacity` | integer nullable — "room for ~20", informational |
| `location` | text nullable — officer sets at scheduling time; sessions may override |
| `proposed_by_membership_id` | → `membership.id` — who submitted (a member, so always a membership) |
| `reviewed_by_membership_id`, `reviewed_at`, `review_note` | officer provenance, matching the `ticket_request` house style |
| `created_at`, `updated_at` | timestamp_ms |

Index on `(edition_id, status)`.

### `offering_session` — one dated instance

`id`, `camp_id`, `edition_id`, `offering_id` (→ `offering.id` cascade, notNull),
`date` (ISO `YYYY-MM-DD`), `start_time` / `end_time` (`HH:MM`),
`location` (nullable override — NULL inherits `offering.location`),
`status` (`scheduled | cancelled`), `note`, timestamps.
Index on `(edition_id, date)`.

**Times are wall-clock strings**, same deliberate convention as the schedule
feature (`db/schema/schedule.ts:26-30`). No epoch, no timezone math.

### `offering_presenter` — presenter + co-presenters

`id`, `camp_id`, `offering_id` (cascade), plus a **nullable `attendee_id`** →
`attendee.id` and a **nullable `name`**, `role` (nullable label — "Presenter",
"Co-presenter", "MC"), `sort_order`, `created_at`. Index on `offering_id`.

Why `attendee_id` and not `membership_id`: `attendee` already models both camp
members and guests (`db/schema/attendee.ts:12-17`), and tickets/passes already
moved to attendee scoping. The nullable-`attendee_id`-or-`name` pair mirrors
`attendee`'s own member-vs-guest pattern, and lets an **outside presenter** (not
camping with us, so not on the roster) be credited by name without polluting the
roster or the headcount.

## Lifecycle

```
camper submits            → proposed
officer accepts           → accepted     (officer may edit title/kind/duration)
officer declines          → declined     (+ review_note explains why)
camper withdraws          → withdrawn
officer adds sessions to an accepted offering → it appears publicly
```

An offering is **published** (visible on the public page) when all of:
`status = accepted` **and** `audience = public` **and** it has ≥1 session with
`status = scheduled`. No separate publish flag — scheduling *is* publishing,
which keeps the model honest (nothing appears publicly without a time and place).

## Routes

| path | who | what |
|---|---|---|
| `/programming` | recruit+ view, member+ propose | Propose form, "your proposals" with status, the accepted lineup by date. Officers additionally get the review queue. |
| `/programming/:offeringId` | recruit+ view | Detail: edit (officer or the proposer while still `proposed`), schedule/cancel sessions, manage presenters. |
| `/c/:slug/schedule` | **public, no auth** | The published lineup — kind, title, blurb, presenters, date/time/location. |

**Role gating:** proposing is **member+** (recruits view only) — a recruit isn't
yet committed to the camp. One-line change in the action if a camp disagrees.
Curation (accept/decline/schedule) is **officer+**, matching every other
management surface.

**Public page gate:** copy the `/c/:slug` pattern exactly
(`app/routes/c.$slug.tsx:37-55`) — resolve camp by slug, then
`getFeatureState(campId, "programming") !== "on"` → **404**. Preview must not
publish a public surface, and a camp that turned it off shouldn't advertise that
the page ever existed. Use `getFeatureState`, NOT `requireFeature` (which
redirects and assumes a session) and NOT `featureVisibleTo` (which would let
officers through during preview).

## Feature-registry integration (from `plans/camp-features.md`)

Adding the key needs **no `camp_feature` migration** — absence of a row means
`defaultFeatureState`, and `programming` is not a `starter` feature, so it
defaults **off**. Existing camps deliberately discover it via Preview rather
than being grandfathered on.

Checklist of files that need a manual edit (the settings page picks it up
automatically by iterating `FEATURES`):

- [ ] `app/lib/features.ts` — add `programming` to the `FeatureKey` union, a
      `FEATURES` entry (label/description), and `ROUTE_FEATURES` (`programming:
      "programming"`) so the preview banner resolves.
- [ ] `app/routes.ts` — register `/programming`, `/programming/:offeringId`,
      and public `c/:slug/schedule` (the last one **outside** the dashboard
      layout, beside `c/:slug`).
- [ ] `app/routes/dashboard/layout.tsx` — `...gated("programming",
      "/programming", "Programming")` in the ordered nav array.
- [ ] `requireFeature(active, "programming")` in **both** loader and action of
      each internal route.
- [ ] `app/routes/dashboard/index.tsx` — Overview card (your upcoming talks;
      officers see the pending-proposal count).
- [ ] `app/routes/dashboard/guide.tsx` — prose bullet, gated on `seeFeature`.

## Plan / steps

- [ ] **Phase 1 — Schema.** `db/schema/programming.ts` + export from
      `db/schema/index.ts`; generate migration (next free number is **0064**;
      re-check before generating). Verify by applying the full chain to a
      throwaway DB.
- [ ] **Phase 2 — Registry + `/programming`.** Feature key, route registration,
      nav. Propose form, "your proposals", officer review queue
      (accept/decline with note).
- [ ] **Phase 3 — `/programming/:offeringId`.** Sessions (add/cancel/delete)
      and presenters (add member-or-guest-or-outside-name, reorder, remove).
- [ ] **Phase 4 — Public `/c/:slug/schedule`.** Published lineup grouped by
      date. No auth, 404 unless the feature is fully on.
- [ ] **Phase 5 — Integration.** Overview card, guide prose, README if warranted.

## Deliberately out of scope (Cameron did not select these)

Not built, but the schema shouldn't fight them later:

- **Venue / A-V needs.** `location` is free text; a link to a `map_object` (the
  Math Camp lecture hall) is the natural later step. No projector/PA tracking.
- **Export to the event's official guide** (Burning Man's WhatWhereWhen). This
  is **event-layer** work per the four-layer architecture — it must not land in
  the core feature. A later `programming-export` seam on the event layer.
- **Presenter reminders** (Discord DM / email). Rides Phase 5 of the parent plan
  when the reminder infrastructure exists.
- **Public RSVP / ticketing for talks.** Explicitly excluded by decision #1 —
  the public has no accounts.

## Things not to do

- **Don't name anything `event`.** Reserved for the event layer. `offering` /
  `offering_session`.
- **Don't reuse `gathering*` tables.** Decision #3. In particular don't try to
  bolt a public audience onto `gathering_signup`, whose `membership_id` is a
  hard FK by design.
- **Don't let `preview` publish the public page.** Preview means "officers
  exploring internally".
- **Don't bake Burning Man in.** No WhatWhereWhen fields, no BRC vocabulary in
  the core tables.
- **Don't add a publish flag.** Scheduling is publishing (see Lifecycle).
- **`bun run db:migrate` does not work here** — migrations apply on app startup
  via the bun-sqlite migrator in `db/client.server.ts`.
- **Before `db:generate`,** check `db/schema/index.ts` for another thread's
  un-migrated table export and comment it out for the generate, then restore it
  — otherwise their table lands in your migration and snapshots.

## Open questions for the user

1. **Should recruits be able to propose?** Currently planned as member+.
   Recommendation: keep member+; it's a one-line change either way.
2. **Multiple sessions per offering** — worth the extra table now, or is one
   date per offering enough? Recommendation: keep `offering_session`; camps
   commonly repeat a popular talk, and collapsing it later is harder than
   ignoring it.

## Progress log

- [x] Design settled with Cameron via four locked questions (2026-07-30).
- [x] Plan written.
