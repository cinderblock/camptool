# Camp meetings — dates, open agendas, a standing meeting room, and summaries

> Task plan. Parent living plan: `plans/camptool.md` (read that first). Surface
> this path in responses while working on the feature.
> Plan path: `plans/camp-meetings.md`

## Goal (user ask, 2026-08-22)

> "I want a new tab for camp meetings — setting dates for them, showing agendas
> (that anyone can add to), automatic meeting rooms (for whatever meeting system
> is configured — just discord for now, so just link to voice channel), and
> distributing summaries."

Four things, in one tab:

1. **Dates** — officers schedule meetings, including a repeating cadence
   (camp meetings are typically weekly or fortnightly in the run-up).
2. **Agendas** — a per-meeting list *anyone who can see the page* can add to,
   so campers bring items instead of remembering them on the call.
3. **Meeting rooms** — every meeting shows a join button for the camp's
   configured meeting system, with nobody pasting a link per meeting.
4. **Summaries** — what was decided, written up after and distributed to the
   camp, so the people who missed it are not left out.

## Locked decisions (user Q&A, 2026-08-22)

1. **Built on `gathering`, NOT a new scheduling entity.** `db/schema/schedule.ts`
   already has `gathering` with `kind = "meeting"`, dated `gathering_occurrence`
   rows, `gathering_shift`/`gathering_signup` (RSVP + attendance) and a calendar.
   Meetings is a **purpose-built view over those rows**, plus three new tables for
   the agenda / room / summary. Dates, recurrence, RSVP, attendance, the calendar
   and "Mine" all come free, and a camp meeting lives in exactly ONE place —
   shown two ways. This is the parent plan's own rule ("there is ONE versioning
   entity … don't design a duplicate table") applied to scheduling.
   → New feature key `meetings` with `requires: ["schedule"]` (the
   `dues → finances` pattern).
2. **Meeting room = one standing room per camp.** An admin pastes the camp's
   room link once on `/settings`; every meeting links it. No bot token, no
   channel permissions, no per-meeting setup — works for any self-hoster today.
   **Not** built: a per-series override, and **not** bot-created channels per
   meeting (would need `DISCORD_BOT_TOKEN` + Manage Channels, and the guild id is
   env-level rather than per-camp — see "Things not to do").
3. **Summaries distribute in-app.** The summary lives on the meeting, past
   meetings list them, and a freshly published one surfaces as an Overview
   to-do until the viewer has read it. **Not** built: Announcements cross-post,
   Discord post, email — all of those are parent Phase 5 delivery work.
4. **Anyone who can see the page can add an agenda item** — recruits included,
   same rule as the FAQ ask queue. The author can edit or withdraw their own
   item; officers can edit or remove any. **Not** built: officer re-ordering,
   "mark discussed", or carry-over of unfinished items to the next meeting.
   The agenda is a flat list in the order items were added, and it is per
   meeting, so it resets naturally each time.

## Locked decisions inherited from the parent plan (don't re-litigate)

- **PRIVATE FIRST.** No public surface of any kind — no unauthenticated read
  path to a meeting, an agenda, a room link, or a summary.
- **Multi-camp invariant.** Every table carries `camp_id`.
- **Edition axis.** Per-meeting data is per-year → carries `edition_id`
  alongside `camp_id`. The **room config is camp-scoped** (like `camp_bins` /
  documents): a camp's voice channel outlives a year.
- **Locked edition = read-only.** Every edition-scoped mutation 403s when
  `activeEdition.locked`.
- **Wall-clock times.** ISO `YYYY-MM-DD` + `HH:MM`, no timezone conversion —
  inherited from `schedule.ts` (see its header for why).
- **Never `title=`.** Hints are inline text, never a hover tooltip.

## Schema — `db/schema/meeting.ts` (migration 0083)

**`camp_meeting_room`** — CAMP-scoped, one row per camp.
- `id, campId`
- `url` — the join link, pasted whole. Discord's right-click → *Copy Link* on a
  voice channel gives `https://discord.com/channels/<guild>/<channel>`, which is
  all we need; a Zoom / Meet / Jitsi / Teams link works identically.
- `label` — what to call it ("Camp voice"); defaults from the detected provider.
- `note` — free text shown under the button ("mic check at :05").
- `updatedByMembershipId`, `createdAt`, `updatedAt`; unique on `campId`.

The **provider is derived from the URL's hostname** (`meetingProvider()` in
`app/lib/meetings.ts`) rather than stored — Discord, Zoom, Google Meet, Teams,
Jitsi, or a generic "Meeting link". That is what makes it "whatever meeting
system is configured" with zero extra configuration, and it can never drift out
of sync with the URL it labels.

**`meeting_agenda_item`** — one line on one meeting's agenda.
- `id, campId, editionId, occurrenceId`
- `title` (required, ≤200), `body` (optional, **wiki markup** — so an item can
  link `[[/map]]` or a wiki page and paste a screenshot).
- `addedByMembershipId` (set null on delete), `createdAt`, `updatedAt`.
- index on `occurrenceId`.

**`meeting_summary`** — the write-up, at most one per meeting.
- `id, campId, editionId, occurrenceId` (unique on `occurrenceId`).
- `body` — wiki markup.
- `authorMembershipId`, `publishedAt` nullable (**null = draft**, officers only),
  `createdAt`, `updatedAt`.

**`meeting_summary_read`** — who has read a published summary.
- `id, campId, summaryId, membershipId, readAt`; unique `(summaryId,
  membershipId)`.
- This is what makes "distributing" real without a mailer: an unread published
  summary is an Overview to-do until the viewer marks it read.

## Routes / UI

- **`/meetings`** — the tab. Next meeting up top with its room button and agenda
  count; then upcoming; then past meetings with their summaries (unread ones
  badged). Officers get a **Schedule a meeting** form: title, date, start/end,
  where, and a repeat cadence (once / weekly / fortnightly / daily) through an
  end date. Recruit+ view.
- **`/meetings/:occurrenceId`** — one meeting. Join button, when/where, RSVP,
  the agenda with an add box, and the summary (officers write/publish/edit;
  everyone else reads a published one and can mark it read).
- **Nav** — "Meetings" in the *What's on* group, next to Schedule.
- **`/settings`** — a **Meeting room** config block under the Meetings feature
  card (the `BinsConfig` pattern), admin-only.
- **Overview** — a to-do card: the next meeting (with a join button on the day)
  and any published summaries the viewer has not read.

RSVP is **not new work**: the meeting page reuses the occurrence's existing
default `gathering_shift` and writes `gathering_signup` rows exactly as
`/schedule/:gatheringId` does, so "who's coming" is the same data in both views.

## Libs

- `app/lib/meetings.ts` (pure, client-safe) — `meetingProvider(url)` hostname
  table, `normalizeRoomUrl`, `datesEvery(start, end, stepDays)` cadence
  materializer + `MEETING_CADENCES`.
- `app/lib/meetings.server.ts` — room config get/set/clear, agenda CRUD, summary
  upsert/publish/mark-read, and the loaders for the list + detail pages.
- `app/lib/schedule.ts` gains **weekly/fortnightly recurrence**
  (`datesEvery` generalizes `dailyDatesBetween`), which Schedule benefits from
  too — it was a listed "later" item there.

## Findings / gotchas

- **`isVisible()` does not auto-wait.** After the create form's `redirect()` —
  a *client-side* navigation — `waitForURL` + `networkidle` both resolve before
  React commits, and `locator.isVisible({timeout})` answers immediately anyway
  (the timeout option doesn't make it retry). It returns `false` every time and
  reads exactly like a broken page. Use `.waitFor({state:"visible"})`.
- **`MarkupTextarea`'s label wasn't tied to its textarea** — it shares a row
  with the picture/link controls, so it can't use Mantine's `label` prop and was
  a floating `<Text>`. `getByLabel("Write-up")` therefore never resolved, and a
  screen reader had the same problem. Fixed at the source with `useId()` +
  `<Text component="label" htmlFor>` + `id` on the `Textarea`; this also fixes
  the wiki, FAQ and prospects editors, which are the other consumers.
- **Deliberate failures pollute the console-error assertion.** The locked-year
  POST probe (403) and the bogus-id navigation (404) both log. Snapshot
  `page.errors` *before* them, or a real error hides behind an expected one.
- **`membership` is `camp_id`, `session` is `active_camp_id`** — not the
  better-auth `organization_id` spellings the org plugin's API returns. Bites
  every time a scratch DB is seeded by hand.

- **Migration numbering.** Latest committed migration at design time is
  **0082**; parallel threads add migrations concurrently, so re-check the
  journal at generate time. `db:generate` in a no-TTY shell splits renames —
  see `reference_drizzle_generate_gotchas`. `db:migrate` does NOT work here;
  migrations apply on app startup via the bun-sqlite migrator in
  `db/client.server.ts`.
- **Only generate MY tables.** `db/schema/index.ts` may export other threads'
  un-migrated tables; confirm the generated SQL contains only `camp_meeting_room`
  / `meeting_agenda_item` / `meeting_summary` / `meeting_summary_read` before
  keeping it.
- **A meeting made on `/schedule` is a meeting.** Anything with
  `kind = "meeting"` appears in `/meetings`, agenda and all — that is the point
  of building on `gathering`. Conversely a meeting scheduled here shows up on
  the Schedule calendar. Don't add a filter that hides one from the other.
- **`requires: ["schedule"]`** means turning Meetings on with Schedule off is a
  half-working page; the settings UI already offers to enable a requirement, and
  `requireFeature` must check both.

## Things not to do

- Don't create a second scheduling entity. `gathering` + `kind="meeting"` is it.
- Don't give a meeting, agenda, room link or summary any public/unauthenticated
  surface (parent decision #0).
- Don't build Discord message-sending or channel-creation in this feature —
  no bot write path exists today and delivery is the parent's Phase 5.
- Don't store the meeting-room provider as a column; derive it from the URL.
- Don't use `title=` for any of the hints.

## Progress log

- [x] 2026-08-22 — design + user Q&A (4 forks locked); plan written.
- [x] Schema — `db/schema/meeting.ts`, **migration 0083** (4 tables). Verified
      by applying it to a `VACUUM INTO` snapshot of the live DB: +4 tables, all
      empty, `PRAGMA foreign_key_check` clean, existing schedule rows untouched.
      `db:verify` green (84 migrations, 76 tables).
- [x] Libs — `app/lib/meetings.ts` (provider detection, URL normalization,
      cadences) + `meetings.server.ts`; `datesEvery` generalizes
      `dailyDatesBetween` in `schedule.ts`, which is where weekly/fortnightly
      recurrence comes from. **20 unit tests**, all passing.
- [x] Feature key `meetings` (default off, `requires: ["schedule"]`), nav entry
      badged with unread summaries, `/settings` meeting-room config.
- [x] `/meetings` list + officer scheduling; `/meetings/:occurrenceId` detail
      with the join button, RSVP, open agenda and the summary.
- [x] Overview home: next-meeting card + an unread-summary to-do per meeting.
- [x] **E2E — `e2e/meetings.ts`, 33/33 green** (`bun run e2e:meetings`). Drives
      two real browser contexts (officer + member) against a dev server: empty
      state → weekly series materializes 4 meetings → Discord join button →
      officer and member each add agenda items → each can edit only their own
      (officer moderates both) → RSVP shows up for the officer → draft summary
      invisible to the member → publish → member's Overview to-do → mark read
      clears it → the same meeting on `/schedule` → locked year read-only in the
      UI *and* 403 on a hand-rolled POST → unlock → bogus id 404s → no console
      errors. Dev server log clean (no SSR throw degraded to a 200).
- [x] typecheck + build + biome + 408 unit tests green; README updated.
- [ ] Later: Announcements cross-post + Discord post of a summary (parent
      Phase 5 delivery); per-series room override; agenda ordering / carry-over;
      bot-created per-meeting channels; guest (attendee) RSVP.
