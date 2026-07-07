# Schedule — gatherings, shifts, sign-ups, attendance + training/permissions

> Task plan. Parent living plan: `plans/camptool.md` (read that first). Surface
> this path in responses while working on the feature.
> Plan path: `plans/events-scheduling.md`
>
> Supersedes an earlier abandoned draft (a first-pass guess from ~15:29, before
> the 2026-07-07 user Q&A; no code, no schema was ever started from it).

## Goal (user ask, 2026-07-07)

A scheduling feature for **work parties, prep sessions, and camp meetings** —
before and during an event. Officers schedule them; campers sign up for
shifts. Concretely:

- Officers schedule a "work party" / "camp meeting" on dates/times; **some are
  all-hands, some are all-available, some need only 1–2 people, some repeat
  daily during the event**.
- Campers **sign up** for gatherings / shifts.
- **Required training / permission sign-offs**: force members to be signed off
  on certain permissions at a **one-time, per-event, or yearly** validity level,
  and gate signups on them.
- **Attendance + substitution tracking**: optionally record who *actually*
  showed for a shift — including when someone who wasn't signed up **steps in**
  (e.g. the scheduled bartender no-shows and another camper covers the bar).
- **Calendar views**: camp-wide schedule + "my shifts".
- **Notifications**: eventually DM/email when things are scheduled.

## Naming — avoid the word "event"

`camp_edition.event` already means the **event layer** (Burning Man vs UnSCruz),
and `app/lib/events.ts` owns that. To avoid a pervasive collision, the internal
entity is **`gathering`** (a work party / meeting / prep session / shift block).
User-facing copy may still say "events/schedule". Feature/route = **Schedule**.

## Locked decisions (user Q&A, 2026-07-07)

1. **Notifications = in-app first.** Surface upcoming gatherings + "my shifts" on
   the Overview home and a calendar. Real Discord-DM / email reminders ride the
   already-roadmapped **Phase 5 notification work**, NOT built in this slice.
   (Discord today is REST-only with no DM-send wired; there is no mailer.)
2. **Sign-up unit = nested shifts/roles.** A gathering → occurrence(s) →
   shift(s) → signup(s). One occurrence can hold several parallel shifts/roles
   (bartender × greeter × cleanup), each separately staffed and signed up for.
3. **Training/permissions = built now** (in the first slice, not deferred).
   Definitions carry a **validity** = lifetime (one-time) | per_edition (re-sign
   each year) | annual (~1yr from grant). Signups on a gathering that requires a
   training are gated on a currently-valid sign-off.
4. **Attendance is optional but always available, and records substitutes.**
   Every shift can track who *could/should* have attended vs who actually did.
   If the scheduled person no-shows and someone else covers, that must be
   recordable — so a signup carries an **origin** (self / assigned / walk_in) and
   an **attendance** outcome (unknown / attended / no_show), and officers can add
   a walk-in signup after the fact.

## Locked decisions inherited from the parent plan (don't re-litigate)

- **Multi-camp invariant.** Every table carries `camp_id`.
- **Edition axis.** Per-year data carries a nullable `edition_id` FK (like
  `map`/`ticket`/`attendee`). Gatherings are per-year → edition-scoped. Training
  *definitions* are camp-scoped (persist across years, like `camp_question` /
  `onboarding_task`); a *sign-off* is scoped by the training's validity.
- **Locked edition = read-only.** Every edition-scoped mutation 403s when
  `activeEdition.locked` (same guard as tickets/passes/bringing).
- **Role gating via `hasAtLeast` / rank** (`app/lib/permissions.ts`). Officer+
  manages; member+ signs up; recruit+ may view.
- **SQLite type modes:** booleans `integer({mode:"boolean"})`, timestamps
  `integer({mode:"timestamp_ms"})` (epoch ms). Snake_case SQL columns, JS keys
  match usage. Ids = `text` UUID PKs. `const now = sql\`(unixepoch() * 1000)\``.

## Schema (target)

Two new files: `db/schema/schedule.ts`, `db/schema/training.ts`. Add both to
`db/schema/index.ts`.

### `db/schema/schedule.ts`

**`gathering`** — the recurring "thing" (camp_id + edition_id).
- `id, campId, editionId`
- `title`, `description`
- `kind` text — soft enum (`work_party | meeting | prep | shift | social |
  other`); label/icon/color live in `app/lib/schedule.ts` (like `structures`).
- `location` text — free text for now ("Bar", "HQ tent"). *Future:* optional FK
  to a `map_object`/`map_zone` so the schedule can point at the map.
- `recurrenceRule` text nullable — human/regeneration hint (e.g.
  `daily:2026-08-25..2026-09-01`). Occurrences are **materialized real rows**
  (not virtual RRULE) so each day is independently editable / cancellable /
  staffable — consistent with the repo's "snapshot, not live link" preference.
- `status` text — `active | archived`.
- `createdById`, `createdAt`, `updatedAt`.

**`gathering_occurrence`** — a concrete dated instance (camp_id + edition_id +
gatheringId).
- `startsAt` (timestamp_ms), `endsAt` (timestamp_ms, nullable), `allDay` boolean.
- `titleOverride`, `locationOverride` (nullable — inherit gathering otherwise).
- `status` text — `scheduled | cancelled`.
- `note`, `createdAt`, `updatedAt`.
- index on `(editionId)`, `(gatheringId)`.

**`gathering_shift`** — a staffable slot within an occurrence.
- `id, campId, editionId, occurrenceId`
- `role` text nullable — "Bartender" / "Cleanup"; null = general/all-hands.
- `staffing` text — `all_hands` (everyone expected, uncapped) | `open` (all
  available, uncapped) | `needed` (target headcount).
- `minNeeded` int nullable, `capacity` int nullable — used when `staffing='needed'`.
- `startsAt`/`endsAt` override (nullable — a shift may be a sub-window of the
  occurrence, e.g. bar 18:00–20:00 then 20:00–22:00).
- `note`, `sortOrder`, `createdAt`, `updatedAt`.
- **Every occurrence gets ≥1 shift** (auto-create a default "General" all-hands
  shift when the officer doesn't specify one), so signups always attach to a
  shift — one code path for both all-hands meetings and multi-role work parties.

**`gathering_signup`** — a person committed to / recorded on a shift.
- `id, campId, editionId, shiftId`
- `membershipId` — who. (MVP: members only. *Future:* `attendeeId` so a guest
  can be recorded as covering a shift; keep decoupled from the attendee
  migration for now — see gotchas.)
- `status` text — `signed_up | maybe | waitlisted | cancelled`. (Intent axis.)
- `attendance` text — `unknown | attended | no_show`. (Outcome axis; officer- or
  self-marked after the shift.)
- `origin` text — `self | assigned | walk_in`. `walk_in` = added by an officer
  after the fact (the substitute who stepped in).
- `note`, `recordedByMembershipId`, `recordedAt`, `createdAt`, `updatedAt`.
- **unique `(shiftId, membershipId)`** — no double-signup; a walk-in for someone
  already signed up just updates their row.
- Capacity: when `staffing='needed'` and signed-up count ≥ capacity, new signups
  land `waitlisted`; officers can promote. all_hands/open never waitlist.

### `db/schema/training.ts`

**`training`** — camp-scoped permission/qualification definition (persists across
years, like `camp_question`).
- `id, campId`
- `name` ("Fire safety", "Generator operation", "RID / bar service"),
  `description`.
- `validity` text — `lifetime | per_edition | annual` (the user's one-time /
  per-event / yearly levels).
- `archivedAt` nullable (soft-retire so sign-offs survive), `sortOrder`,
  `createdAt`.

**`training_signoff`** — a member is signed off on a training.
- `id, campId, trainingId, membershipId`
- `editionId` nullable — set for `per_edition` validity (which year it covers);
  null for lifetime; annual uses dates.
- `grantedByMembershipId`, `grantedAt` (timestamp_ms).
- `expiresAt` timestamp_ms nullable — for `annual` (grantedAt + 1yr); null =
  no time expiry.
- `note`, `revokedAt` nullable.
- index `(trainingId, membershipId)`. **Current validity is computed in code**
  (`isValidSignoff`) from validity + editionId + expiresAt + revokedAt, rather
  than over-constrained by a unique index (renewals create new rows).

**`gathering_requirement`** — a gathering requires a training.
- `id, campId, gatheringId, trainingId`
- `enforcement` text — `required` (block signup without a valid sign-off) |
  `warn` (allow but flag).
- First slice: requirement at the **gathering** level (applies to all its
  shifts). *Future:* optional shift-level requirement (role-specific) via a
  nullable `shiftId` with exactly-one-of `(gatheringId, shiftId)`.

## Signup gating logic

On signup to a shift: load the gathering's `gathering_requirement` rows; for
each, check the member has a currently-valid `training_signoff` (via
`isValidSignoff` against the active edition + now). Missing + `required` → 403
with "You need the *X* sign-off first"; `warn` → allow, mark the signup flagged.
Officers assigning a member bypass with a confirm (their judgment is the
authority, same spirit as invite-redeem / member-remove rank overrides).

## Routes / UI

- **`/schedule`** — calendar + agenda. Views: **Calendar** (month grid),
  **Agenda** (upcoming list), **Mine** (my shifts). Filter by `kind`. Member+
  sign up / withdraw / RSVP inline; officer+ gets a "New gathering" button. Build
  the month grid + agenda ourselves (no calendar dep; `@mantine/dates` is already
  in for date inputs). Recruit+ view, member+ signup.
- **`/schedule/:gatheringId`** — detail: occurrences, shifts, per-shift signup
  lists, requirements. Officer management (add/edit/cancel occurrences+shifts,
  set staffing/capacity, attach requirements, mark attendance, add walk-ins,
  assign members) + member signup on that gathering. One file, role-split like
  `tickets.tsx`/`passes.tsx`.
- **`/training`** — officer defines trainings (name/validity/description) and
  grants/revokes sign-offs (roster grid: member × training); member+ sees their
  own sign-offs + status/expiry. Recruit+ view own.
- **Nav** (`app/routes/dashboard/layout.tsx`): "Schedule" (recruit+),
  "Training" (member+, shows own quals; officers see management).
- **Overview home** (`routes/dashboard/index.tsx`): a card for **upcoming
  gatherings + my shifts this week**; officers also see **shifts still needing
  people**. Reuses the existing Overview to-do pattern.

## Client + server libs

- `app/lib/schedule.ts` (pure, client-safe): kind/staffing/status catalogs
  (value/label/icon/color), recurrence generator (rule + range → occurrence
  timestamps), formatting helpers, capacity/needs helpers.
- `app/lib/schedule.server.ts`: loaders/actions (list gatherings for edition,
  gathering detail, signup/withdraw, attendance mark, occurrence/shift CRUD),
  all edition + lock + role gated.
- `app/lib/training.ts`: validity catalog + `isValidSignoff(signoff,{edition,
  now})` predicate + label helpers.
- `app/lib/training.server.ts`: load trainings, load a member's valid sign-offs,
  grant/revoke, `missingRequirementsFor(membership, gathering, edition)`.

## Timezone (gotcha to handle up front)

Times are epoch ms (`timestamp_ms`). Display in the **event's timezone**, not the
server's or a naive local. BM = `America/Los_Angeles`. Add a tz to the event
layer (`app/lib/events.ts`) and format with `Intl.DateTimeFormat(..., {timeZone})`.
Officer inputs (date + time) are entered in that same event tz and converted to
epoch on save. Don't store wall-clock strings; don't assume the browser tz.

## Phases (each a coherent, shippable, green commit)

1. **Schema + libs.** `schedule.ts` + `training.ts` tables; migration (verify on
   a VACUUM-INTO copy of the live DB); the pure `schedule.ts`/`training.ts` libs
   with script verification of the recurrence generator + `isValidSignoff`.
2. **Officer authoring.** `/schedule` create gathering → occurrences (incl.
   "repeat daily during event" generator) → shifts (role/staffing/capacity);
   `/schedule/:id` management. No member signup yet.
3. **Member signup + calendar.** Calendar/Agenda/Mine views; member+ signup /
   withdraw / RSVP with capacity → waitlist; Overview home card.
4. **Training + gating.** `/training` defs + sign-offs; `gathering_requirement`;
   signup gating + officer override; "you need X" messaging.
5. **Attendance + substitution.** Per-shift attendance marking (attended/no_show)
   + officer walk-in add; a post-shift roster view.
6. **(Later, Phase 5 of parent) notifications.** Discord DM / email reminders on
   schedule + upcoming-shift reminders — rides the parent's notification work.

Per phase: typecheck + build + biome green; migration verified on a DB copy;
update `plans/camptool.md`; commit staging **only this task's files** (shared
tree); push + watch CI green.

## Findings / gotchas

- **Migration numbering + uncommitted schema exports (this repeatedly bites).**
  Latest committed migration is **0051** (journal is source of truth — re-check
  at generate time; parallel threads add migrations concurrently). `db/schema/
  index.ts` currently exports **`attendee`** and **`flag`** which are
  **uncommitted / may lack migrations**, and `season.ts` is modified
  (participation folded into attendee). Running `db:generate` for schedule/
  training could **swallow `attendee` / `member_flag` / season changes** into my
  migration. Mitigation (documented pattern from the invite-notes work): before
  generating, confirm which of those already have migrations; temporarily toggle
  their `index.ts` exports off so my migration contains ONLY `gathering*` /
  `training*`, then restore. Verify the generated SQL by eye.
- **`db:migrate` (drizzle-kit) does NOT work here** — migrations apply on app
  startup via the bun-sqlite migrator in `db/client.server.ts`. Use `db:generate`
  to author; restart to apply.
- **Keep signups on `membershipId`, not `attendeeId`, for now** — decouples this
  feature from the in-flight attendee migration (`plans/whos-coming-attendees.md`).
  Extending signups/attendance to guests (attendeeId) is a clean later step once
  attendee lands.
- **Nested-shift model must not make simple meetings tedious.** Auto-create a
  default "General" all-hands shift for occurrences with no explicit shift, so a
  camp meeting is a two-field create, not a four-level slog.

## Open questions for the user (recommendation in **bold**)

1. **Calendar UI depth** — build a lightweight month grid + agenda ourselves
   (**recommended**, no new deps) vs pull a calendar library. Leaning DIY.
2. **Who can sign others up** — officers assign anyone; can a member sign up a
   guest/another member? **MVP: self-signup + officer-assign only**; guest/other
   signup later with the attendee extension.
3. **Recurrence scope** — is "repeat daily during the event" (gate-open →
   event-end, from `eventWindowFor`) enough, or do you also want weekly / custom
   intervals now? **MVP: none + daily-through-event; weekly/custom later.**
4. **Location = free text now**, map-linked later — OK? (**recommended** to keep
   the slice focused.)

## Things not to do

- Don't name the entity `event` (collides with the event-layer concept).
- Don't store wall-clock time strings or assume the browser/server tz — epoch ms
  + event tz.
- Don't build Discord/email delivery in this feature — in-app first; delivery is
  the parent plan's Phase 5.
- Don't gate map/attendee migrations into this feature's migration (see gotcha).
- Don't assume a single camp; every table carries `camp_id`.

## Progress log

- [x] 2026-07-07 — design + user Q&A (4 forks locked); plan written.
- [ ] Phase 1 — schema + libs + migration.
- [ ] Phase 2 — officer authoring UI.
- [ ] Phase 3 — member signup + calendar + Overview card.
- [ ] Phase 4 — training + signup gating.
- [ ] Phase 5 — attendance + substitution.
