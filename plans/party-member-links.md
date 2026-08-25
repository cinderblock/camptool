# Linking members into a party ("Grace is Albert's plus-one")

## Goal

Make it possible — and visible — that two people with **their own accounts** are
attending together as one household. The motivating case: Grace is a bonafide
Math Camp member/officer, and she's coming as a "maybe" *with* Albert, sleeping
in his domicile. Today the roster can express her "maybe" and (barely) that
she's in his tent, but nothing says the two of them are one party.

Secondary goal: stop the current workflow from *destroying* that link when a
double-count is cleaned up (see Findings).

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\CampTool`, branch `master`.
- Live at `camptool.mathcamp.us` (routes have no `/dashboard` prefix).
- Relevant schema: `db/schema/attendee.ts`, `db/schema/map.ts` (`map_object`,
  `map_object_occupant`).
- Relevant server code: `app/lib/attendee.server.ts`, `app/lib/party-map.server.ts`,
  `app/lib/merge.server.ts`.
- Relevant UI: `app/routes/dashboard/roster.tsx`, `app/routes/start.tsx`
  (onboarding wizard, the only writer of occupants), `app/routes/dashboard/map.tsx`.
- Adjacent plans: `plans/whos-coming-attendees.md` (the attendee entity),
  `plans/roster-map-linkage.md` (party → map highlight).

## Decisions already made (don't re-ask)

1. **The party link is a fact in its own right**, not shorthand for "shares a
   domicile." It's true before any tent is placed, it explains why Grace's RSVP
   is "maybe", and it survives the two of them ending up in separate structures.
2. **Reuse `attendee.host_membership_id`** rather than adding a table. Its honest
   meaning becomes *"here as part of this member's party"*; being a guest is the
   separate, orthogonal fact `membership_id IS NULL`. This also means a guest who
   later gets an account **keeps** the party edge through promotion instead of
   losing it.
3. ~~**Who can set it:** either person … No confirmation handshake — small,
   high-trust camp.~~ **Superseded 2026-08-25 by decision 6.** This was decided
   while the link only *displayed* a household. Decision 5, taken later the same
   day, turned it into a grant of authority, and the "no handshake" rationale was
   never re-examined against that. See the escalation under Findings.
4. **One level deep.** A member who is hosted cannot themselves host; you cannot
   host yourself. Keeps the party roll-up a single hop and matches how a household
   actually has one anchor.
5. **A party host is an officer scoped to their party.** Albert can manage
   tickets and setup passes for everyone in his party; the people in it can also
   still manage their own. Authority is **directional** — Grace being in Albert's
   party gives him reach over her things, not her over his. This resolves the
   open question about ticket/SAP visibility: yes, and deliberately so.

   Two predicates fall out, and the distinction matters:

   - `inMyParty(att, myMembershipId)` — self **or** someone I host. Drives
     *visibility* ("Your tickets"). Officers must NOT be folded in, or an
     officer's own party card would swell to the whole camp.
   - `canManageAttendee(att, viewer)` — `inMyParty` **or** camp officer. Drives
     *mutation*.

6. **Being taken into a party requires the taken person's consent; joining one
   does not.** (2026-08-25, replacing decision 3.) The two directions are not
   symmetric and the UI is built on that difference:

   - *Join someone's party* — you write your **own** `host_membership_id`. You
     are giving your tickets and passes away, which is yours to do. Immediate.
   - *Take someone into yours* — you would write **their** row, taking their
     tickets and passes. That is an invitation they answer.

   Stated as an invariant: **the only non-officer who may write
   `host_membership_id` on a member's row is that member.** Officers keep the
   direct write; they already have reach over everyone, so it escalates nothing.

   The invitation lives in `attendee.pending_host_membership_id` and is inert —
   `party.ts` never reads it, so inviting the whole camp grabs nobody's things.

## Findings / gotchas

### Privilege escalation: any member could take over any other member *(fixed)*

Reported by the user on 2026-08-25 — "what if someone else in the camp wanted to
mess with things and take my SAP?" — and it was not, as hoped, merely invisible
to an admin. The gate in `roster.tsx` read:

```ts
const involved = subject === myMid || host === myMid;
```

`host === myMid` is true of *every* attempt to grab somebody, so it authorized
exactly what it was meant to prevent. Any member could POST
`intent=setPartyHost&membershipId=<victim>&hostMembershipId=<self>` — and did not
need to forge it, since `CampingWith` rendered its "Add someone to your party"
picker to every member behind nothing but `!locked`, populated with the whole
camp. On success the attacker immediately gained, through `canManageAttendee`:

| Route | Effect on the victim |
|---|---|
| `passes.tsx` `cancelPass` | **deletes** their pending setup-pass request |
| `passes.tsx` `setStay` | rewrites their arrival/departure dates |
| `passes.tsx` `requestPassFor` | files a pass request in their name |
| `tickets.tsx` `markPurchased` | flips their ticket status |
| `inMyParty` readers | reads their tickets and passes |

Mitigations that existed but weren't enough: the grab was visible on the
victim's own roster and self-serve reversible — but only after the fact, only if
they looked, and a cancelled pass request was already gone.

Root cause is a decision-ordering one worth remembering: decision 3 ("no
confirmation handshake") was taken when the link was **display only**, and
decision 5 turned it into a privilege grant later the same day without
revisiting it. Fixed by decision 6 above.

### The invariant is prose-only — the DB would accept both columns set

`db/schema/attendee.ts:79-86` has no CHECK constraint; migration
`db/migrations/0049_special_infant_terrible.sql` confirms two plain nullable FKs.
The member/guest split at `attendee.ts:10-16` is documented in a comment and
upheld only by convention in the three insert sites (`attendee.server.ts:215`,
`attendee.server.ts:336`, `wizard.server.ts:124`). So the change is mostly about
**teaching the readers** to distinguish "has a host" from "is a guest" — several
of them currently conflate the two.

### Three readers break if a member row gets a host, and one is destructive

| Site | Current behavior | Why it breaks |
|---|---|---|
| `attendee.server.ts:78-93` (`loadRoster` guest query) | selects any row with `host IS NOT NULL` | Grace renders as her own roster row **and** as a grape guest badge under Albert |
| `attendee.server.ts:156-170` (`headcountFor`) | `guests = count(host not null)`, then `membersComing = totalComing − guests` | Grace subtracts herself from the member count |
| `party-map.server.ts:74` | `add(r.membershipId ?? r.hostMembershipId, …)` | prefers the member's own id, so Grace's occupancy of Albert's tent keys under *Grace* — the roster and map disagree about whose party it is |
| **`attendee.server.ts:231-257` (`getGuest`)** | filters `isNotNull(hostMembershipId)` only | **Destructive.** `removeGuest` (`:285-311`) would happily delete a linked *member's* attendee row — wiping their RSVP, releasing their ticket, revoking their setup pass. Must gain an `isNull(membershipId)` guard **before** any UI can set a host on a member row. |

### The current workaround actively destroys the link

The only member↔guest bridge today runs backwards. Albert adds "Grace" as a
free-text guest; Grace also has her own member row; she's double-counted; she
clicks **"That's me"** (`roster.tsx:1106-1121` → `claimGuestAsMember`,
`merge.server.ts:259-304`) — which *merges the guest row away entirely*, taking
`host_membership_id` with it (`merge.server.ts:298` sets it to NULL explicitly).
Fixing the double-count deletes the exact relationship we want to show. After
this work, that affordance should offer **link** as well as **merge**.

### There is no "add an existing member" path anywhere

`roster.tsx:737-760` (the `MyParty` card) posts `intent=addGuest` with only a
free-text `name`/`email`/dates; the action at `roster.tsx:149-167` hardcodes
`hostMembershipId: myMid` and never sets `membershipId`. No member picker exists.

### Same-domicile IS already modeled — and is nearly invisible

`map_object_occupant` (`db/schema/map.ts:163-189`) points an **attendee**
(member or guest) at a `map_object`, unique on `(object_id, attendee_id)`,
shipped in migrations `0052` / `0053`. But:

- The **only** writer is the onboarding wizard's sharing step
  (`app/routes/start.tsx:162-211` loader, `:453-540` action, `:1121-1241`
  component), and only the object's **owner** can use it
  (`eq(mapObject.ownerMembershipId, mid)`, `start.tsx:467`).
- The map editor never loads occupants — in the ~9k-line
  `app/routes/dashboard/map.tsx`, `mapObjectOccupant` appears only in snapshot
  save/restore (`:319-366`). `plans/roster-map-linkage.md:55-58` already admits:
  *"who sleeps where is currently invisible on the map."*
- The roster's Where cell (`roster.tsx:1125-1145`) only ever says "N on map".

So "they haven't entered the data" is *partly* true for the domicile half — but
entering it today would barely show anything.

### No structure capacity exists

Grep for `capacity|sleeps` on `map_object` returns nothing. Out of scope here,
but worth knowing before anyone asks "does Albert's yurt fit them both?"

### "Party" is derived, never stored

`app/lib/party-map.server.ts` unions `map_object.owner_membership_id` with
`map_object_occupant → attendee`, keyed by host membership id. Consumers:
`roster.tsx:82-84` (the `mapItems` count, the Where link, the mini-map
`highlightIds` at `:1257-1270`) and `map.tsx:595-610` `resolveParty` feeding
`?party=`. The word is reused loosely for host+guests in
`attendee.server.ts:176`, `roster.tsx:573`, and the ticket/pass "mine" tests.

## Plan / steps

### Phase 1 — make the invariant explicit and safe *(do this first, alone)*

Pure hardening; no behavior change while all hosts are still guests. Landing it
separately means the destructive path is closed before anything can exercise it.

- [ ] `getGuest` (`attendee.server.ts:231`) gains `isNull(attendee.membershipId)`.
      This is the guard that stops `removeGuest` from deleting a member.
- [ ] `loadRoster`'s guest query (`:78-93`) gains `isNull(attendee.membershipId)`.
- [ ] `headcountFor`'s guest count (`:156-164`) gains the same.
- [ ] Introduce a shared predicate (e.g. `isGuestRow` / `isPartyMemberRow` in
      `attendee.server.ts`) so the three sites can't drift apart again.
- [ ] Update the `attendee.ts` header comment: `host_membership_id` = "here as
      part of this member's party"; guest = `membership_id IS NULL`.
- [ ] Consider a CHECK (`host_membership_id IS NULL OR host_membership_id <>
      membership_id`). SQLite needs a table rebuild for this — see
      `plans/migration-timestamp-skip.md` and the db:generate gotchas before
      committing to it. App-level enforcement is required either way.

### Phase 2 — party roll-up and one authorization helper *(done)*

- [x] `app/lib/party.ts` — `inMyParty` (visibility), `canManageAttendee`
      (mutation), `isMe` (self only). Pure, unit-tested in `party.test.ts`.
      Replaces six inlined comparisons: `tickets.tsx` loader + `markPurchased`,
      `passes.tsx` loader + `cancelPass`, `roster.tsx` guest edit.
- [x] `party-map.server.ts` → `add(r.hostMembershipId ?? r.membershipId, …)`.
- [x] `loadRoster` returns `partyHost: {membershipId,name} | null` and
      `partyMembers: […]` per member.
- [x] Roster resolves a linked member's map items **through their host**, since
      the roll-up gives a household one key. Without this Grace's row reads "not
      placed" while she is asleep in Albert's tent.
- [x] Roster visibility filter keeps a party anchor visible even with no RSVP —
      the same reason the `guests.length > 0` clause already existed. Found by
      driving the page: Bob's row vanished, orphaning the link.

Behavior changes to be aware of:

- **Officers gained two powers.** `markPurchased`/`unmarkPurchased` and
  `cancelPass` previously excluded officers; `canManageAttendee` includes them.
  Deliberate — whether a ticket got bought is a fact about the world, and an
  officer reconciling the allocation should be able to record it.
- **`cancelPass` stopped lying.** It used to return `ok: "Request cancelled."`
  even when the authorization check failed. Now 403 "Not your pass."
- `passes.tsx` gained a server-computed `isSelf` so the request form keys off a
  real self test instead of rebuilding `m:${id}` on the client.

### Phase 3 — write paths *(done, bar the officer row control)*

- [x] `setPartyHost({campId, editionId, membershipId, hostMembershipId})` in
      `attendee.server.ts`. Keyed by **membership**, not attendee id — the caller
      is picking a person off the roster — and creates the attendee row via
      `ensureMemberAttendee` if they haven't RSVP'd. Refuses, with a message
      written for the person reading it, on: self-link, a host that is itself
      hosted, a subject that already hosts people.
- [x] `getPartyHostOf` and `listPartyHostCandidates` (excludes self and anyone
      already in a party; someone who hosts *guests* is still a valid anchor).
- [x] `setPartyHost` action intent on the roster.
- [x] A `CampingWith` card, separate from `MyParty` (which is about accountless
      guests). Shows only the applicable half, since the one-level rule makes the
      two mutually exclusive.
- [ ] Officer control to set/clear the host on **any** roster row. The action
      already authorizes officers; only the per-row UI is missing, so an officer
      currently has to ask one of the two people to do it.
- [ ] `claimGuest` ("That's me") gains a **link instead of merge** option.

### Phase 6 — consent before authority *(done, 2026-08-25)*

- [x] `attendee.pending_host_membership_id` (migration `0084_kind_skin`), with
      `ON DELETE SET NULL` **hand-added** to the generated SQL: drizzle-kit drops
      the referential action from a SQLite `ADD COLUMN`, and cascade would have
      been wrong anyway — deleting the *inviter's* membership must not delete the
      invitee's whole attendee row. Same trap as `0065_fix_missing_on_delete`.
- [x] `setPartyHost` gate narrowed to: the subject themselves, the subject's
      current host (clearing only), or an officer. `checkPartyLink` extracted so
      the one-level-deep rules are shared with the invite path.
- [x] `invitePartyMember` / `acceptPartyInvite` / `clearPartyInvite`, plus
      `loadPartyInvites` (scoped to the viewer, *not* hung off `RosterMember` —
      the roster's member list is shipped to every browser in camp).
- [x] `CampingWith` reworked: an invitation banner with both answers, sent
      invites shown as "Waiting on them" with Withdraw, and the picker relabelled
      "Ask someone to join your party".
- [x] Ask-registry entry `party_invite`, so the question reaches the person
      instead of sitting on a page they may not open. `required` — but saying
      *no* satisfies it too, so it's a one-tap question, not a debt.
- [x] `e2e/party-invites.ts` — 21 checks, including the original attack POST and
      the pass-cancellation it used to enable.

Deliberate non-goals here: a member with a pending invite is still listed in
everyone's picker (the refusal explains it better than a silent omission would),
and a second inviter is refused rather than allowed to overwrite the first.

The authorization rule here is deliberately NOT `canManageAttendee`. That answers
"does this viewer already have authority over that person?", and before the link
exists a prospective host has none — the authority is what's being created. So
the rule is stated directly in the action: either of the two people involved, the
current host (for clearing), or an officer.

**Two pickers, not one with two buttons.** Which direction you pick decides who
can manage whose tickets, so it has to be an explicit choice rather than a
consequence of which button you happened to hit: "Add someone to your party" (you
get their tickets) versus "Or join someone else's party" (they get yours). The
second is hidden once you anchor a party.

### Phase 4 — make it visible *(mostly done)*

- [x] Roster Party cell: a linked member renders as a default-coloured badge,
      visibly distinct from the grape guest badges (guests stay grape per the
      convention at `start.tsx:1185`) because they have accounts of their own.
- [x] The relationship reads from both sides — the host's row lists the member,
      the member's row shows an outline `with <host>` badge. Verified in the
      running app against a seeded link:

      Name             | RSVP     | Arrives | Departs | Party            | Where
      Bob              | No reply | -       | -       | Cameron Tacklind | 6 on map
      Cameron Tacklind | Maybe    | -       | -       | with Bob         | 6 on map

- [ ] Where cell: name the structure ("Albert's yurt") rather than "6 on map",
      so co-domicile is legible without opening the map. Both rows currently
      point at the same party, which is right but under-explains.

### Phase 5 — occupants beyond the wizard *(optional, separable)*

- [ ] Let occupants be edited outside onboarding — either on the map editor
      (which doesn't load them at all today) or from the roster row.

## Open questions for the user

1. ~~Should Albert see Grace's ticket and setup pass?~~ **Answered: yes** — see
   decision 5. A host is an officer for their own party.
2. Should a party link be **per-edition** (it lives on `attendee`, so it already
   is) or sticky year-to-year? Recommendation: leave it per-edition; households
   change, and re-affirming it each year is a feature.
3. Officers gained two powers they didn't have (see the Phase 2 note on
   `markPurchased` / `cancelPass`). Flag if that's wrong.

## Things not to do

- **Don't** make guests into real `user`/`membership` rows, and **don't** add a
  free-text "party size" integer without names — both are explicit anti-goals in
  `plans/whos-coming-attendees.md:342-347`.
- **Don't** add a separate household/party entity. Decision 2 above; the derived
  host-keyed party already has two working consumers.
- **Don't** let any UI set a host on a member row before Phase 1's `getGuest`
  guard lands — `removeGuest` would delete a real member's RSVP, ticket
  assignment and setup pass.
- **Don't** infer the link from shared domicile. It was considered and rejected:
  it's empty before placement, and it can't express "coming because of Albert."

- **Don't** let "I named myself as the host" count as authorization for writing
  `host_membership_id`. That clause is true of every hostile attempt; it is the
  exact bug fixed on 2026-08-25. Any future write path to that column must state
  its rule as *who owns the row being written*, not who's named in the payload.

- **Don't** read `pending_host_membership_id` in `party.ts` or any permission
  check. Its whole value is being inert — the moment a pending invite grants
  anything, sending one becomes an attack again.

## Progress log

- [x] 2026-08-07 — Investigated. Established that the domicile half is modeled
      but nearly invisible, the person half is not modeled at all, and the
      existing "That's me" flow destroys the link. Decisions 1-4 locked with the
      user.
- [x] 2026-08-07 — Phase 1 shipped (`83677ee`): `isGuestRow`, the `getGuest`
      guard, schema comment. Verified against a seeded DB that the old predicate
      both matched a linked member in `getGuest` (so `removeGuest` would have
      deleted them) and inflated the guest count.
- [x] 2026-08-07 — Decision 5 locked: a party host is an officer scoped to their
      party, directional.
- [x] 2026-08-07 — Phases 2 and most of 4 built. Verified by driving the roster
      in a dev server against a seeded link, not just by unit test — which is how
      the orphaned-host filter bug surfaced.
- [x] 2026-08-07 — Phase 3 built and driven end to end (link, unlink, both
      directions, all three refusals). Driving it caught two more bugs that no
      unit test would have:

      1. Someone *added* to a party disappeared from the shown roster — they had
         no RSVP yet, and the visibility filter only knew about `partyMembers`,
         not `partyHost`. Both directions now keep a row visible.
      2. **Owned** structures didn't follow the party anchor, only occupancy did.
         When Bob (owner of six placed objects) joined Cameron's party, both rows
         read "not placed" — Bob's objects were still keyed under Bob while the
         roster asked under Cameron. `partyMapObjects` now resolves every
         attachment, owner and occupant alike, through one `hostOf` map.
- [x] 2026-08-25 — Phase 6. The user asked whether joining a group had a
      permission hole. It did, and it was not admin-only — every member could
      take over every other member. Decision 3 retired, decision 6 taken,
      invitation flow built and driven end to end against a scratch DB. The
      single e2e failure turned out to be my own assertion string: React's SSR
      escapes `'` to `&#x27;`, so a needle containing "you're" never matches the
      markup, and the banner had been rendering correctly all along.

### How to drive the app locally

The forged-session recipe below still works, but there is now a **much cheaper
path** for anything server-side: sign up over HTTP against a scratch DB and post
form-encoded intents, no browser and no cookie forging. See
`e2e/party-invites.ts` (and `e2e/trip-and-occupants.ts`, which it's modelled on):

    DATABASE_PATH=./data/verify/party.db \
      PUBLIC_BASE_URL=http://localhost:17937 PORT=17937 bun run dev
    DATABASE_PATH=./data/verify/party.db \
      E2E_BASE_URL=http://localhost:17937 bun e2e/party-invites.ts

Both processes need `DATABASE_PATH` — the suite reads the DB directly to assert
on rows. Grep the dev log for errors afterwards regardless of the result: an SSR
throw still returns HTTP 200, so a green run is not proof the page rendered.

#### The forged-session recipe (this cost an hour to work out)

`bun run dev` on port 17923 against a throwaway DB copy, with a forged session:

- Copy the dev DB with **`VACUUM INTO`**, not `cp` — the database is in WAL mode,
  so a plain copy silently loses everything still in `-wal` (the copy came up
  with no `attendee` table at all).
- The session cookie name is **`__Secure-better-auth.session_token`**, NOT
  `camptool.session_token`. `auth.server.ts:22` only applies the `camptool`
  prefix when `PUBLIC_BASE_URL` is localhost, and this checkout points at
  `https://camptool.isozilla.com`. Read the truth from
  `(await auth.$context).authCookies.sessionToken.name`.
- Sign the token with better-auth's own `makeSignature(token, secret)` from
  `better-auth/crypto` — standard base64 **with** padding, not base64url. The
  cookie value is `` `${token}.${sig}` `` URL-encoded.
- `/dashboard/*` bounces to `/start` unless `membership.wizard_step != 0`
  (`layout.tsx:74`) — it is `wizard_step`, not `wizard_completed_at`.
- `bun -e` and Git-Bash disagree about `/tmp`; keep scratch files in the repo.
- Kill the dev server by the PID holding port 17923, not `pkill bun` — there are
  usually other bun processes around that belong to other work.
