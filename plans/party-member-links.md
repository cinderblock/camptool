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

### Phase 2 — party roll-up

- [ ] `party-map.server.ts:74` → `add(r.hostMembershipId ?? r.membershipId, …)`,
      and update the file header comment (`:12-13`) to say the roll-up follows the
      party host for members too. Verify the roster mini-map and `?party=` still
      agree.
- [ ] `loadRoster` returns, per member, both `guests` (unchanged) and a new
      `partyWith: { membershipId, name } | null` plus `partyMembers: […]` for the
      host side.

### Phase 3 — write paths

- [ ] `setPartyHost(attendeeId, hostMembershipId | null)` in
      `attendee.server.ts`, enforcing: same camp + edition; not self; target is
      not itself hosted; the subject hosts nobody.
- [ ] `MyParty` card: "Add someone" offers **an existing member** (picker) or a
      **new guest** (current free-text form).
- [ ] Grace's own RSVP surface: "I'm coming with…" member picker.
- [ ] Officer control on any roster row to set/clear the host.
- [ ] `claimGuest` ("That's me") gains a **link instead of merge** option.

### Phase 4 — make it visible

- [ ] Roster Party cell (`roster.tsx:1078-1124`): linked members as a chip
      distinct from the grape guest badges (guests stay grape per the convention
      at `start.tsx:1185`), showing the member's name.
- [ ] The hosted member's own row reads the relationship back — "with Albert" —
      so it's legible from either direction.
- [ ] Where cell: name the structure ("Albert's yurt") rather than "1 on map",
      so co-domicile is finally visible on the roster.

### Phase 5 — occupants beyond the wizard *(optional, separable)*

- [ ] Let occupants be edited outside onboarding — either on the map editor
      (which doesn't load them at all today) or from the roster row.

## Open questions for the user

1. Should Albert see Grace's **ticket and setup pass** in his party view? The
   "mine" test at `tickets.tsx:116`,`:283` and `passes.tsx:94`,`:278` is
   `attMembershipId === myMid || attHostId === myMid`, so linking them grants
   this *automatically* unless we exclude member rows. My recommendation: allow
   it (that's what a household means), but call it out in the UI so it isn't a
   surprise — Grace is an officer, not a dependent.
2. Should a party link be **per-edition** (it lives on `attendee`, so it already
   is) or sticky year-to-year? Recommendation: leave it per-edition; households
   change, and re-affirming it each year is a feature.

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
      user. Nothing implemented yet.
