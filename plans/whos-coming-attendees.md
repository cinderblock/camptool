# Who's coming this year — guests / party members / attendee headcount

> Task plan. Parent living plan: `plans/camptool.md` (see the "participation is a
> PRIMARY axis" section). Read that first.

## Goal (user ask, 2026-07-07)

The members list is persistent across years, but there's no clear **"who is
coming to *this event, this year*"** with a headcount. And a member often manages
attendance for people who have **no account** — e.g. Albert registers, but his
wife is coming too; he needs to say "my group is 2 people," ideally with their
names, and that must roll into a per-year headcount.

## What already exists (before this task)

- `participation` (`db/schema/season.ts`) — per **member × edition**: `status`
  (`unknown|coming|maybe|not_coming`), `arrivalDate`, `departureDate`, `note`.
  Written by the onboarding wizard (`/start`, `wizard.server.ts`). **This is the
  member's own RSVP.**
- `map_object_occupant` — additional people sharing a tent/RV/car, but keyed by a
  real `membershipId` (a user WITH an account). **A non-member guest can't be an
  occupant today.**
- `ticket.assignedMembershipId`, `setup_pass.membershipId` — DGS tickets and
  Setup Access Passes assign to a **membership** only.
- **No roster / headcount view** anywhere — `participation` is never surfaced as
  a "who's coming" list or total.

## The gap

A "body at the event this year" that is NOT a camp member (no user account) has no
representation. Albert's wife needs: a name, to count in the headcount, to be able
to share Albert's tent (map occupant), and possibly her own ticket + SAP.

## User-locked decisions (2026-07-07 Q&A)

1. **Guest detail = FULL attendee record** — name, own arrival/departure dates,
   AND their own ticket / Setup-Access-Pass needs (each body needs a BM ticket).
2. **Unify occupants** — a map occupant can be a member OR a guest; Albert's wife
   shows up sharing his tent, and the headcount + map stay consistent.
3. **Tally lives in BOTH places** — a headcount summary card on the Overview home
   + a full per-edition roster breakdown page.
4. **Attendees are promotable to recruit/member accounts (2026-07-07).** A guest
   who later makes an account becomes a real membership. Because occupancy /
   tickets / passes reference `attendeeId`, promotion just **links a membership
   onto the existing attendee row** (set `membershipId`) — every reference follows
   for free; nothing is re-pointed. This is the payoff of the unified model. Add
   an optional `email` to `attendee` so promotion can send a better-auth
   invitation; on accept, the new membership links back to the attendee.

## Architecture decision — CONFIRMED (A) Unified `attendee`, 2026-07-07

User picked the unified attendee model. Everything the guest plugs into
(headcount, map occupancy, tickets, SAPs) is a facet of "a person attending the
event this year," so there is ONE entity for it.

- **(A) Unified `attendee` entity (CHOSEN).** One row = one body at the event
  for an edition. `membershipId` nullable (set → this attendee IS a camp member;
  null → a guest). `hostMembershipId` = who manages a guest. Carries status +
  arrival/departure/note. Then `map_object_occupant`, `ticket`, and `setup_pass`
  reference `attendeeId` (not `membershipId`). `participation` folds into the
  member's own attendee row. **Cleanest long-term; the live DB has ~no data to
  migrate right now (1 camp / 1 user), so the timing is ideal** (the parent plan
  explicitly says do foundational refactors now while migration is cheap).
- **(B) `participation_guest` sidecar.** Keep everything as-is; add a guest table
  hanging off a host membership. Occupants/tickets/passes each grow a nullable
  `guestId` beside their `membershipId` (exactly-one-of, enforced in code).
  Lower churn, but duplicates the assignee reference in 3 tables and leaves two
  notions of "attendee" (member vs guest) forever.

## `attendee` schema (target)

```
attendee {
  id, campId, editionId,
  membershipId?      // set = this body IS a camp member (unique per edition,
                     //   partial index WHERE membership_id NOT NULL); null = guest
  hostMembershipId?  // the member who manages this guest (null for a member's own row)
  name               // display name (guest's name; member's row can mirror user.name)
  email?             // optional — enables promotion via better-auth invitation
  status             // unknown | coming | maybe | not_coming
  arrivalDate?, departureDate?   // ISO YYYY-MM-DD
  note?
  createdAt, updatedAt
}
```
The member's attendee row REPLACES their `participation` row (status + dates +
note move here). `participation` is dropped after backfill.

## Phases (each a coherent, shippable commit)

- **Phase 1 — attendee entity + headcount + roster (the headline value).**
  - `attendee` table; migrate every `participation` row → a member attendee row
    (membershipId set); **drop `participation`**. Repoint the two readers
    (`wizard.server.ts`, `passes.tsx`) + writer (`setParticipation`) to `attendee`.
  - Guest CRUD: a host member adds/edits/removes named guests (name + dates) for
    the active edition.
  - Wizard `/start`: a "who else is in your party?" step after the member's RSVP.
  - Roster page + Overview headcount card (coming members + their guests).
  - Occupants/tickets/passes UNTOUCHED this phase (still `membershipId`; they only
    involve members, who now also have an attendee row).
- **Phase 2 — unify occupants.** `map_object_occupant.membershipId` →
  `attendeeId`; occupant picker offers members + the host's guests.
- **Phase 3 — tickets + SAPs per attendee.** `ticket.assignedMembershipId` and
  `setup_pass.membershipId` → `attendeeId`; assignee Selects include guests.
- **Phase 4 — promote attendee → recruit/member.** Officer (or host) invites a
  guest by email → better-auth invitation; on accept the new membership links onto
  the attendee row (set `membershipId`, keep host as inviter). Nothing else moves.

Per phase: typecheck + build + biome green; migration verified on a VACUUM-INTO
copy of the live DB; update `plans/camptool.md`; commit (stage only this task's
files — shared tree); push + watch CI.

## Progress log

- [x] **Phase 1 — attendee entity + headcount + roster (CODE COMPLETE, green;
      not yet browser-tested).** 2026-07-07.
  - `db/schema/attendee.ts` — new `attendee` table (member row = membershipId set;
    guest row = hostMembershipId set; name/email; status/arrival/departure/note;
    partial unique index on (edition, membershipId)).
  - `participation` dropped; folded into member `attendee` rows.
    **Migration 0049** (create `attendee` + backfill INSERT…SELECT from
    participation — member rows, name/email NULL) + **0050** (drop participation).
    Split into two generates so drizzle-kit's rename resolver never prompted (no
    TTY here); `flag.ts` temporarily hidden from `index.ts` during both generates
    so another thread's un-migrated `member_flag` didn't get swept into mine.
  - Verified: full chain 0000→0050 applies on a fresh DB; isolated backfill test
    copied every field correctly (member row → host/name/email NULL, status/dates/
    note/timestamps carried); `foreign_key_check` clean. (Live DB had 0
    participation rows, so seeded a synthetic one for the copy test.)
  - `wizard.server.ts` + `passes.tsx` repointed off `participation` → `attendee`
    (member's own row). Public API names (`setParticipation`, `state.participation`)
    kept stable to limit blast radius; `/start` RSVP flow unchanged, now attendee-
    backed.
  - `app/lib/attendee.server.ts` — `loadRoster`, `headcountFor`, guest CRUD
    (`addGuest`/`updateGuest`/`removeGuest`/`getGuest`/`listGuests`).
  - `app/routes/dashboard/roster.tsx` — `/roster` "Who's coming · <year>": headcount
    stat cards (total heads = members coming + guests), a self-service **"Your
    party"** card (add/edit/remove guests with name + optional arrival/departure),
    and a full roster table (RSVP badge, arrival, party). Guest edits gated to host
    or officer; blocked when the year is locked.
  - Nav link "Who's coming" (`layout.tsx`), route wired (`routes.ts`), and an
    overview headcount card linking to `/roster` (`index.tsx`).
  - typecheck + build + biome green (my files).
- [ ] Phase 1 follow-up: a wizard `/start` "who else is in your party?" step
      (deferred — the roster's Your-party card is the durable home; onboarding
      pointer is a nicety).
- [ ] Phase 2 — unify occupants (`map_object_occupant` → attendeeId).
- [ ] Phase 3 — tickets + SAPs per attendee.
- [ ] Phase 4 — promote attendee → recruit/member.

## Findings / gotchas

- **drizzle-kit `db:generate` needs a TTY** for the create-vs-rename resolver.
  Dropping one table + adding another in a single generate triggers the prompt →
  fails with no TTY. Fix: split so each generate has no simultaneous create+drop
  (create+backfill first, drop second).
- **`member_flag` (flag.ts) is another thread's un-migrated table** in the shared
  tree. Any `db:generate` sweeps it into your migration. Hide `export * from
  "./flag"` in `index.ts` during generate, then restore — keeps it out of your
  migration AND your snapshots (preserving the status quo for that thread).
- Live `data/camptool.db` on disk is **stale** (predates `arrival_date`); don't
  seed against its participation schema. The dev server applies migrations on
  startup, so the running DB is current but the file lags.

## Findings / gotchas

- The working tree already has uncommitted migration-snapshot churn from other
  threads (`0011–0023_snapshot.json`) — stage only this task's files.
- Migration numbering: check the journal for the latest before generating; other
  threads may be adding migrations concurrently (this repeatedly bites — see the
  arrival-SAP plan's HELD note).

## Things not to do

- Don't make guests real `user`/`membership` rows — they have no account and
  shouldn't get auth, a role, or appear in the member directory as members.
- Don't add a free-text "party size" integer without names — the user wants
  names, and named bodies are what tickets/SAPs/occupancy need to attach to.
