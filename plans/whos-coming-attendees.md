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

- [x] **Phase 1 — attendee entity + headcount + roster. DEPLOYED + BROWSER-TESTED
      (commit 22924f2, Deploy to firefly green).** 2026-07-07.
  - Live E2E on camptool.mathcamp.us: `/roster` rendered with **real prod data**
    backfilled correctly (17 members' RSVP statuses + arrival dates folded from
    participation → attendee; 1 maybe). Added a guest to Cameron's party → toast,
    headcount 17→18 heads / guests 0→1, roster row showed "+1 (Roster Test Guest)";
    removed it → back to 17/0. Confirms migration backfill on production data +
    the full guest write/tally path. No console issues observed.
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
- [x] **Phase 2 — unify occupants (CODE COMPLETE, green; not yet browser-tested).**
      2026-07-07. `map_object_occupant.membership_id` → `attendee_id` (a member OR
      guest). **Migration 0052** (add nullable `attendee_id` + backfill: create an
      `unknown` attendee row for any occupant-member lacking one, then point each
      occupant at it) + **0053** (drop `membership_id`, rebuild, unique index now
      `(object_id, attendee_id)`). Two prompt-free generates (add col / drop col),
      flag hidden during both. Verified: full chain 0000→0053 + isolated backfill
      (a member occupying two objects got ONE created attendee, both occupants
      linked; a member with an existing attendee reused it). `start.tsx` sharing
      step now offers **members + the viewer's own guests** (grouped Select,
      `m:`/`a:` prefixed refs → resolved to an attendeeId via
      `ensureMemberAttendee`); occupant badges show guests in grape. `map.tsx`
      snapshot code is column-agnostic (untouched). typecheck + build + biome green.
      **DEPLOYED (commit 29d1613, Deploy to firefly green) + browser-checked live:**
      the wizard Sharing step loaded on real prod data (occupant loader join works),
      Cameron's Hyparhut showed the grouped "Add someone…" picker with a **Campers**
      group listing members (no guests group since he had none). Didn't mutate prod.
- [x] Phase 3 — tickets + SAPs per attendee (3a host-managed, user-picked).
  - [x] **3a-tickets (CODE COMPLETE, green; not browser-tested).** 2026-07-07.
    `ticket.assigned_membership_id` → `assigned_attendee_id` (member OR guest).
    **Migration 0054** (add col + backfill: ensure attendee for each assigned
    member, then link) + **0055** (drop membership col, rebuild). Verified full
    chain + backfill on a DB copy. `tickets.tsx`: loader resolves each ticket's
    assignee to a `m:`/`a:` ref + a `mine` flag (my own row OR my guests);
    "Your tickets" shows the whole party with names + per-ticket mark-purchased
    (host acts for guests); officer assign Select is grouped Campers/Guests;
    assign resolves the ref via `ensureMemberAttendee`; request auto-resolve only
    for member refs. typecheck (my files) + build + biome green.
    **DEPLOYED (commit 78e14c1, Deploy to firefly green) + browser-tested live:**
    the ticket backfill preserved Cameron's real assigned+PURCHASED ticket through
    the migration (shown via the new party "Your tickets" with his name label); the
    officer table resolved the assignee name; the assign Select opened grouped with
    a **Campers** section (Guests group would appear when guests exist). Didn't mutate.
  - [x] **3a-passes (CODE COMPLETE, green).** 2026-07-07. Was briefly deferred
    when a concurrent thread's migration 0056/0057 collided with the numbering;
    once those landed on remote (settling the head at 0057), redone cleanly:
    `setup_pass.membership_id` → `attendee_id`. **Migration 0058** (add col +
    backfill: ensure attendee for each pass member, then link) + **0059** (drop
    membership col, rebuild, unique now `(pass_date_id, attendee_id)`). Verified
    full chain 0000→0059 + backfill on a DB copy. `passes.tsx`: passes carry a
    holder ref/name + `mine` (my party); "Your passes" shows my own + my guests'
    (officer-granted) with names; officer grant Select grouped Campers/Guests;
    `activePassFor`/quota now per-attendee. Member self-service request stays
    self-only (ensures own attendee); officers grant guest passes directly.
    `start.tsx` SAP prompt + auto-request repointed to attendee. typecheck +
    build + biome green.
- [x] Phase 4 — promote guest → recruit (2026-07-16). **Deviation from the
    design note below:** promotion uses a one-use PERSONAL INVITE LINK
    (`/i/:token`), not a better-auth org invitation — while building this we
    found better-auth invitations are created (recruits accept-by-email path)
    but have NO acceptance surface or invitation email anywhere in the app, so
    that path dead-ends (standalone gap, noted under Open questions).
    Implementation: `camp_invite.promote_attendee_id` (**migration 0063**,
    FK → attendee, set-null); redeeming such an invite adopts the guest's
    attendee row — `membership_id` set, host/name/email cleared — so RSVP,
    occupancy, tickets, and passes follow into the account (i.$token.tsx).
    Roster "Your party" rows get an "Invite to join" button (host or officer;
    `getOrCreatePromotionInvite` is idempotent — re-click returns the same
    link) showing a copyable URL. Invite tree records the host as inviter;
    role locked to recruit. E2E over HTTP on a scratch server: full golden
    path + probes (idempotency, one-use rejection after redemption, adoption
    clears host/name/email) — 19/19. Gotcha: new camps default features OFF
    (registry `starter` only) — the E2E had to enable `roster` via /settings.
    typecheck + biome green; not browser-tested (plain button + copy link UI).

- [x] **Roster readability pass (2026-08-07, user ask).** Three changes plus a
      bug found while making them:
  - **Hide the noise.** `/roster` listed every member including `not_coming`
    and `unknown` — that's just the camp list wearing a gray badge, and it
    buried the people actually coming. Now only coming/maybe show, with a
    `N not coming · M no reply` count and a **Show them** toggle (client-side;
    the loader is unchanged, so nothing new is exposed). A declined member who
    still has guests listed stays visible — hiding the host would hide and
    orphan their guests.
  - **Arrives is a weekday chip**, not a bare ISO date: day name, a per-weekday
    color (Sun red → Sat grape) so same-day arrivals match at a glance, and a
    **dashed border for setup** (before gates open) vs solid during the event.
    The ISO date stays beside it. Color is never the only channel — the weekday
    is always spelled out and the border is a second, non-color signal — and a
    legend under the header states both, since `title=` tooltips are banned.
  - **Departs column added**; rows sort by arrival (undated last, then by name),
    so the column reads as a timeline.
  - Guest badges in the Party column now carry their own `Tue (setup) → Mon`,
    and "Your party" rows show their dates.
  - **Bug fixed:** the guest Edit modal submitted only name + note, but the
    `updateGuest` action writes whatever the submit carries — so renaming a
    guest silently **wiped their arrival and departure dates**. The modal now
    has both date fields. Verified over HTTP: a modal-shaped edit preserves
    both dates.
  - New `app/lib/arrival.ts` (client-safe weekday chip + setup classification);
    `eventStartIso` added to `brc.ts`, which also de-duplicates the three copies
    of its local `YYYY-MM-DD` formatter. Setup/event boundary uses the
    BRC-approximate `eventStartFor` the wizard and SAP flow already use for all
    events — `eventStartIso` is the one place to repoint when a real per-edition
    event calendar exists.
  - **Browser-verified** on a VACUUM-INTO copy of the live DB seeded with 10
    members across all four statuses and dates spanning setup + event week:
    filtering (9 shown / 13 with toggle), sort order, weekday colors, dashed-vs-
    solid borders, the legend's gate-open date (Sun, Aug 30 for 2026), guest
    chips, and the date-preservation fix. typecheck + lint + build + tests green.
  - Repo hygiene fixed in passing: `bun run format` was reformatting drizzle's
    generated `db/migrations/meta/*.json` on every run (churn that has bitten at
    least one earlier session — see the stash log) — `db/migrations/**` is now in
    biome's ignore list. And `@types/node` is now an explicit devDependency:
    `tsconfig.json` names `"node"` in `types`, but it was only ever present as a
    transitive dep of `bun-types`, so a reinstall dropped it and `bun run
    typecheck` failed with TS2688.

## Open questions for the user

1. **better-auth invitations dead-end** (found 2026-07-16): `/recruits` accept
   for an applicant WITHOUT an account calls `auth.api.createInvitation`, but
   no invitation email is sent and no accept surface exists — the applicant
   never learns they were accepted. Options: (a) swap that path to the same
   personal-invite-link mechanism as guest promotion (officer gets a copyable
   link to send), (b) build invitation email + accept page. Recommendation:
   **(a)** — consistent, works today, no email infra needed.

## Design notes for Phases 3–4 (surfaced to user 2026-07-07)

**Phase 3 tension.** Today `ticket.assignedMembershipId` / `setup_pass.membershipId`
assume the assignee is a **logged-in member**: the member self-requests, sees
"Your tickets", and self-marks purchased; SAPs are member-requested. A **guest has
no account**, so a guest's ticket/SAP must be **managed by their host** (or an
officer), not self-served. Options for guest tickets/SAPs:
  - **(3a) Host-managed** — repoint assignee to `attendeeId`; a guest's
    ticket/SAP is requested + marked-purchased by their host (the host sees their
    party's tickets under "Your tickets"). Officers assign to any attendee. Most
    faithful to "each body needs a ticket", moderate rework of tickets/passes.
  - **(3b) Promote-first** — DON'T make tickets/SAPs guest-assignable; instead a
    guest who needs their own ticket gets **promoted to a member** (Phase 4) and
    then uses the normal self-service. Simplest; leans on Phase 4; a guest with no
    account never holds a ticket row.
  - **(3c) Headcount-only** — guests count toward "how many tickets/SAPs we need"
    (a needs tally) but are never assigned individual ticket rows. Lightest.

**Phase 4 (promotion) mechanics.** A guest with an `email` → officer/host sends a
better-auth org **invitation** (role recruit/member). On accept, the new membership
must **link back onto the guest's attendee row** (set `membership_id`, clear
`host_membership_id`) so occupancy/tickets follow. Needs a stored
"invitation → attendee" link applied at accept time (hook in the invite-redeem path,
`i.$token.tsx` / org invitation accept).

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
