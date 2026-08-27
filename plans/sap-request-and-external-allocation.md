# An explicit "requesting a SAP" control, and allocating a pass outside camp

> Task plan. Parent living plan: `plans/camptool.md`.
> Related: `plans/arrival-sap-and-removal.md` (the entitlement half — requests,
> grants, "on or after" dates), `plans/sap-import-and-distribution.md` (the
> stock half — import, assign, release), `plans/wizard-step-homes.md` (why
> `/trip` owns the write and `/start` posts to it).

## Goal

Two asks (Cameron, 2026-08-27):

1. On **Your trip**, a camper needs an **explicit "requesting a Setup Access
   Pass" option**. It **auto-fills when an early arrival is picked**, but it
   **can be turned off**.
2. As an **admin**, allocate a SAP **outside CampTool** — take a pass out of
   stock and give it to someone who is not a member, not a guest, not an
   attendee at all. "Just in case."

## Decisions (locked)

### Ask 1 — the request is a standing answer, not a one-time button

- Today the prompt only exists **while** the arrival is early, and asking is a
  one-way click with no way back. That makes "do you want a pass?" a question
  the camper can only ever answer *yes* to, and only from one screen state.
  It becomes a **checkbox that is always there** (whenever the passes feature
  is visible and they're coming/maybe), with a state you can read at a glance
  and change either way.
- **Auto-fill happens on the server, in the `rsvp` write** — not as a
  client-side default. A checkbox that merely *looks* ticked until you press
  something else is the failure mode here: the camper believes they asked, the
  officer queue has never heard of them, and the gap surfaces at the gate.
  Saving an early arrival date creates the request row, so the tick mark and
  the officer's queue are the same fact.
- **Turning it off is sticky**, via a new `setup_pass.status = "declined"`.
  Deleting the row instead would let the next date edit silently re-request,
  which is exactly the "can be disabled" the ask is about. `declined` is the
  camper's own no; `denied` stays the officer's no. **No migration** — `status`
  is already a free-text column.
- **`declined` settles the onboarding to-do.** `asks.server.ts` counts any
  non-`denied` row as settling `setupPassSettled`, so an explicit "no thanks"
  clears the required ask the same way asking does. That is right: the ask is
  "tell us whether you need one", and they told us.
- **What you cannot turn off here:** a pass that has actually been set aside or
  released for you. Unticking would either be a lie or a silent hand-back of a
  scarce, possibly already-sent secret. The control goes read-only with the
  reason and points at an officer.
- **Moving your arrival later does NOT auto-withdraw the request.** Silently
  cancelling a request for a scarce resource is worse than a stale one, and the
  officer queue already shows every requester's arrival date. The control
  instead says "you're arriving after gates open — you probably don't need
  this", and the camper unticks it if they agree.
- `/passes`'s existing `cancelPass` still **deletes** — it is a different act
  ("withdraw this ask", available to hosts and officers for other people),
  where `/trip`'s control is a standing statement about yourself. Cancelling on
  `/passes` and then editing your dates will re-offer, which is correct: you
  are still arriving early.

### Ask 2 — external allocation is a stock transition, not a new kind of pass

- The pass leaves the pool to a **named person outside the app**:
  `setup_pass_stock.external_holder` (new column, migration **0085**), with
  `assigned_attendee_id` staying NULL. Status is the ordinary `assigned` →
  `released`. No parallel state, no second table: the pass is still one of the
  camp's N passes and still shows up in the count it should.
- **Only from `available`.** Handing a pass to an outsider while a camper holds
  it should be two deliberate acts — take it back, then allocate — so the
  camper's request reopens visibly instead of being reassigned out from under
  them.
- **Admin-only**, matching `voidStock`: this is the one transition that gives
  camp property to someone with no membership, and it is the one nobody else
  can audit by recognising the name.
- **Release still works and is still the one-way door.** For an external pass
  the codes have no in-app recipient, so the released row grows a **Download
  pass PDF** link for officers — that is the hand-over path, and without it the
  feature would allocate a pass it could never deliver.
- Codes stay behind `visibleCodesFor` unchanged: an external pass joins to no
  attendee, so `membershipId`/`hostMembershipId` are NULL and only the officer
  branch can match. No camper's "mine" filter can ever pick one up.
- Coverage arithmetic needs no change and must not get one: an externally
  allocated pass is `assigned`, so it stops being spare, and it is attached to
  no attendee, so it never makes anybody look served.

## Steps

- [x] `db/schema/sap.ts`: `external_holder`; header note. Migration
      **0085_minor_songbird** (one `ADD COLUMN`).
- [x] `db/schema/ticket.ts`: document `declined` on `setup_pass.status`.
- [x] `sap.server.ts`: `allocateStockExternally`; `assignStock`/`unassignStock`
      clear the holder; `releaseStock` accepts an external holder;
      `stockForEdition` / `stockWithCodes` select it; `loadMySapState` and
      `autoRequestSetupPass` for the trip control.
- [x] `/trip` loader + action: `sap` block on `TripData`; `requestSetupPass`
      revives a `declined` row; new `declineSetupPass`; `rsvp` auto-requests on
      an early arrival.
- [x] `start.tsx`: the same `sap` block from the same resolver.
- [x] `TripPlanner.tsx`: `SetupPassSwitch` replaces the conditional prompt.
- [x] `/passes`: admin allocate-external modal, external rows in the stock
      table (name + "outside the camp" badge), download link on released
      external passes.
- [x] `e2e/sap-passes.ts` extended — sections 20 (the switch) and 21 (external
      allocation). **80 assertions, 0 failures.**
- [x] typecheck + build + biome + 416 unit tests green; migration chain verified
      from scratch (`db:verify`, 86 migrations / 76 tables) and applied to a
      VACUUM-INTO copy of the dev DB (column present, `foreign_key_check` clean).
- [x] `e2e/trip-and-occupants.ts` (29), `e2e/account-and-wizard.ts` (16) and
      `e2e/party-invites.ts` (21) re-run against the same scratch server, since
      the `TripData` shape changed under them. All green, dev-server log clean.
- [x] README + `plans/camptool.md` updated; commit **a476a80**; pushed;
      "Deploy to firefly" green; `/_version` on camptool.mathcamp.us returns
      `a476a808…`, so migration 0085 applied on startup and the build is live.
- [ ] **Open:** click the switch and the "Outside camp" button once on the live
      deploy (see the browser-automation note under Findings).

## Findings / gotchas

- **The loader was handing every member the whole camp's stock list.**
  `/passes` returned `stock` — every pass with its holder's *name* — to every
  viewer, not just officers, and React Router serialises loader data into the
  document. Not codes (those were correctly gated), but not theirs either, and
  the first external allocation would have put an outsider's name in every
  camper's page source. Fixed: `allStock` stays server-side for the officer
  tables and the derived lists; `stock` in the payload is `allStock` for an
  officer and `.filter(s => s.mine)` for everyone else. Found by an assertion
  that expected an outsider's name to be absent from a member's page and wasn't.
- The `declined`/`denied` split has to survive `asks.server.ts`, which settles
  `setupPassSettled` on any non-`denied` row. That is the behaviour we want —
  a decline is an answer — but it means adding a third "no" status there in
  future needs the same thought.
- An e2e check that quietly skips is worse than one that fails: 20k originally
  guarded on `if (forEarly)` and silently did nothing, because every earlier
  block had consumed the imported stock. It now imports its own order and
  throws if there is none.
- Browser click-through was **not** completed: the Chrome tab rendered at a
  broken zoom and would not accept typed input at the login form (three
  attempts, then stopped per the anti-rabbit-hole rule). Server behaviour and
  SSR-rendered content of both new surfaces are covered by the e2e instead.
  Mantine `Switch` is already used in `admin.tsx` / `fuel.tsx` / `map.tsx`, and
  the allocation modal is the same shape as the proven `VoidModal`, so neither
  is an unexercised component — but a human should still click the switch and
  the "Outside camp" button once on the live deploy.

## Things not to do

- Don't make the trip switch a client-side default that only writes when
  something else is submitted. The whole point is that the tick and the
  officers' queue are one fact.
- Don't let a member's decline delete the row. Deleting is how the next date
  edit silently re-asks, which is the behaviour being removed.
- Don't allow an external allocation straight off an assigned pass. Take it
  back first, so the camper's request reopens where they can see it.
- Don't add an "un-external" that returns a *released* outsider's pass to the
  pool. Same reason release is one-way for everyone else.
