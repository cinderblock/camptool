# Outstanding asks — "what does the camp still need from me?"

## Goal

A camper should never have to discover what's owed by clicking around. One
derived list: what's outstanding for *me*, right now, with a link to where to do
it. It must survive bailing out of the wizard, and adding a feature that wants
member input must mean adding an entry to a registry — not editing four
surfaces.

Officers get the roll-up: who still owes what, so it can be chased before the
event.

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\CampTool`, branch `master`.
- Live at `camptool.mathcamp.us`. Dev: port 17923 — see
  `plans/party-member-links.md` for the forge-a-session recipe (WAL copy,
  `__Secure-better-auth.session_token`, `wizard_step != 0`).
- Prior art this builds on: `app/lib/wizard.ts` (`ASKS` registry),
  `app/lib/wizard.server.ts` (`loadWizardState`), `app/lib/features.ts`
  (`FEATURES` catalog + `ROUTE_FEATURES`), `db/schema/season.ts` (`wizard_ask`),
  `db/schema/question.ts` (`camp_question` / `question_answer`).

## The core defect this fixes

`wizard_ask` records **resolution** — the camper clicked Next or Skip — not
**satisfaction**, whether the data actually arrived. Consequences today:

- Bailing out of the wizard is invisible. `wizard_step` flips to 1 on first load
  of `/start` and the forced redirect never fires again
  (`app/routes/dashboard/layout.tsx:59-85`).
- An officer adding a new required question never re-nags anyone who already
  resolved the questionnaire step — flagged as an open question at
  `plans/questions-unification.md:180-182`.
- `wizard_completed_at` is written by **nothing** (grep: schema + migrations
  only). `plans/camptool.md:1166` already marks it for a drop migration.

The target is already locked at `plans/camptool.md:1327-1336`: *"Onboarding =
auto-derived progress, NOT a manual checklist… a read-out of state, not a to-do
list ticked by hand. (Today it's still manual self-tick — this is the target.)"*
This plan is that backlog item plus its sibling, "in-app member-visible
lifecycle/onboarding overview".

## Decisions already made (don't re-ask)

1. **In-app only this round.** No email, no Discord DM. There is no mail
   transport wired at all — `sendMagicLink` `console.log`s the link
   (`app/lib/auth.server.ts:127-133`) — so delivery is a separate project with
   its own provider config, templates, unsubscribe and scheduler.
2. **Officer roll-up is in scope.** "Who still owes what" is what actually gets
   things chased down, and it's the same derivation run for everyone.
3. **One registry, not two.** The wizard's stepper becomes a *view* over the new
   registry (entries flagged `wizard`), rather than a second parallel catalog.
   Two registries would drift within a release.
4. **Satisfaction is derived from data, dismissal is stored.** An ask is
   outstanding when it is scheduled AND not satisfied AND not dismissed. Only
   `optional`/`recommended` asks can be dismissed; a `required` ask ignores
   dismissal, so a newly-added required question re-nags automatically.
5. **Predicates are pure over a snapshot.** Each ask gets
   `isSatisfied(snapshot) => boolean` with no database access, so the whole
   registry is unit-testable without a DB and one batch of queries serves every
   surface.
6. **Batch by default.** `loadAskSnapshots(campId, editionId)` returns a
   `Map<membershipId, AskSnapshot>` for the whole camp; the single-member case is
   `.get(mid)`. Same reasoning as `partyMapObjects` — one code path means the
   member view and the officer view cannot disagree. Camps are a few hundred
   people at most.

## Findings / gotchas

### ~12 of ~23 real asks are tracked by nothing

Tracked by the wizard today: profile, questionnaire, bringing, extras, sharing,
checklist. **Not tracked anywhere:** map placement, ticket request, ticket
marked-purchased, setup pass, fuel declaration, supplies claim, training,
dues/contribution, party links, guests, programming offering, shift sign-ups.

### The dashboard to-do card already exists, hardcoded

`app/routes/dashboard/index.tsx:397-423` builds `todos: {key, label, to?}[]` from
four `if` statements against a bespoke `overview` object assembled by
hand-written per-feature queries at `:134-295`. That descriptor shape is already
right; it's the derivation that's missing. Card renders at `:462-494`, empty
state "You're all caught up. 🎉".

Note `dues` pushes a to-do with **no `to:`** (`:412-416`) because `/dues` is
officer-only — a to-do a member cannot act on. Either give members a dues page or
drop the item; don't ship an unactionable row.

### `loadWizardState` already has three divergent consumers

Nav link as a boolean (`layout.tsx:84`), dashboard as a count
(`index.tsx:397-423`), guide as a full timeline (`guide.tsx:82-131`). All three
should become views over one derivation.

### `showFinishSetup` costs a full `loadWizardState` on every dashboard page

Three queries including `loadFeatureStates`, for non-officers, on every route —
then throws the count away and renders a bare label
(`app/routes/dashboard/layout.tsx:84`, `:185-188`). Officers are exempt from it
entirely, which is also why officers currently see no to-dos at all.

### `AskDef` is the right shape, missing two fields

`app/lib/wizard.ts:34-51` already carries `label`, `hint`, `audience`,
`feature`, `opensWeeksBefore` / `closesWeeksBefore`, `priority`. It needs
**`route`** and **`isSatisfied`**. Note `priority` is currently decorative —
nothing branches on it (passed to the client at `start.tsx:290`, never read).

### The client-safe / server split is deliberate

`app/lib/wizard.ts:1-12` documents that the catalog has no server imports so the
loader and the React component share one source of truth. Keep that: registry in
`app/lib/asks.ts`, queries in `app/lib/asks.server.ts`.

### Feature gating is the "don't nudge toward a bouncing page" rule

`scheduleAsks` (`wizard.ts:139-152`) drops asks whose feature isn't
`featureVisibleTo` the camper. `requireFeature` redirects to `/` rather than
404ing, so an ungated to-do would link somewhere that bounces. Preserve this.

### Extensibility direction is currently one-way

A feature can *suppress* an ask (`AskDef.feature`), but `CampFeatureDef`
(`app/lib/features.ts:46-155`) has no `asks` field — nothing lets a feature
*declare* what it needs from a member. That inversion is the extension point the
user asked for.

## Plan / steps

### Phase A — the registry *(done)*

- [x] `app/lib/asks.ts`: `AskDef` (adds `route`, `importance`,
      `isSatisfied(snapshot)`, `wizard?`), `AskSnapshot`, 15 asks, and pure
      `outstandingAsks` / `askProgress`.
- [x] `app/lib/asks.test.ts` — 23 tests, no DB needed.

### Phase B — the snapshot *(done)*

- [x] `app/lib/asks.server.ts`: `loadAskSnapshots(campId, editionId, year)` →
      `Map<membershipId, AskSnapshot>`, one query per concern grouped by
      membership. Seeded from the roster so a camper with no rows anywhere still
      gets a snapshot — which is exactly the person this is for.

### Phase C — member surfaces *(done, bar the guide)*

- [x] Dashboard "Your to-do" derived from `outstandingAsks`. Only `required`
      rows get a badge; badging every row makes the list read as uniformly
      urgent, which is how people learn to ignore it.
- [x] Nav: a count badge on Overview rather than the bare "Finish setup" link,
      and officers are no longer exempt — they were the only people the app
      never told what they owed.
- [ ] Guide timeline should read `askProgress` instead of `loadWizardState`.

Verified in the running app for a camper with nothing done:

      Overview [6]

      Your to-do                                   2026
      [needed] Say whether you're coming            → /start
      [needed] Sort out your ticket                 → /tickets
      Give your arrival and departure dates         → /start
      Say who's sleeping in your structures         → /start
      Link your Discord account                     → /settings
      Anything else we should know?                 → /start

### Phase D — the wizard becomes a view

- [ ] `scheduleAsks` filters the new registry; `/start`'s `AskBody` switch keys
      off the same strings. Keep `wizard_ask` as the dismissal record.

### Phase E — officer roll-up

- [ ] Outstanding-count column on `/roster`, and a drill-down of who owes what.

## Open questions for the user

1. `/dues` is officer-only, so members can't act on the dues to-do. Give members
   a read-only dues page, or drop that item? Recommendation: a member-visible
   dues page — the number is meaningless without somewhere to look at it.
2. Should *officers* see their own to-dos? They're exempt today. Recommendation:
   yes — an officer is also a camper who owes a ticket and a fuel declaration.

## Things not to do

- **Don't** build a second ask entity. `camp_question` / `question_answer` is
  the officer-authored, audience-tagged, per-edition-or-lifetime ask entity and
  is fully landed (migration 0056).
- **Don't** let a to-do link to a page the camper's role or the camp's feature
  state would bounce them off.
- **Don't** ship a to-do with no route (see the dues note).
- **Don't** treat `wizard_ask.status = 'done'` as satisfaction for any ask that
  has a real `isSatisfied` — that's the bug being fixed.

## Progress log

- [x] 2026-08-07 — Surveyed. Established resolution-vs-satisfaction as the core
      defect, enumerated ~23 asks (12 untracked), confirmed the dashboard card
      and `AskDef` shape as the things to build on. Decisions 1-6 locked.
- [x] 2026-08-07 — Phases A-C built and driven end to end. Ran the derivation
      against every camp in the dev database before wiring any UI, which is how
      the feature-gating and season windows got confirmed against real feature
      states rather than assumed.

### Gotchas found while driving it

- **`export DATABASE_PATH=...` — inline `VAR=x nohup bun run dev &` does not
  reach the server.** An inline assignment worked earlier in the session and
  silently didn't this time; the symptom is the forged session 302-ing to
  `/login` because the server is still on `camptool.db`. Export it, and confirm
  by checking the session actually authenticates.
- A second nav entry pointing at `/` would have collided on `key={item.to}` in
  `layout.tsx`, so the count is a `rightSection` badge on Overview instead. The
  renderer already had that slot for the `preview` badge.
- Another thread is working on passkey signup in this tree (`e2e/`,
  `app/lib/passkey-signup.server.ts`, `app/routes/api.passkey-signup.tsx`,
  `plans/passkey-first-auth.md`). `bun run lint` fails on **their** files; lint
  your own explicitly before concluding anything is broken.
