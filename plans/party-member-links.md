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
3. **Who can set it:** either person (Albert can add Grace to his party; Grace can
   name Albert from her own RSVP), **and officers** on anyone's behalf while
   cleaning up the roster. No confirmation handshake — small, high-trust camp.
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

## Findings / gotchas

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

### Phase 3 — write paths *(next)*

### Phase 3 — write paths

- [ ] `setPartyHost(attendeeId, hostMembershipId | null)` in
      `attendee.server.ts`, enforcing: same camp + edition; not self; target is
      not itself hosted; the subject hosts nobody.
- [ ] `MyParty` card: "Add someone" offers **an existing member** (picker) or a
      **new guest** (current free-text form).
- [ ] Grace's own RSVP surface: "I'm coming with…" member picker.
- [ ] Officer control on any roster row to set/clear the host.
- [ ] `claimGuest` ("That's me") gains a **link instead of merge** option.

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

### How to drive the app locally (this cost an hour to work out)

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
