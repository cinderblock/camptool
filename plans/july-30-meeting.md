# July 30 camp meeting — bugs + feature requests

> Task plan. Parent living plan: `plans/camptool.md` (read that first).
> Plan path: `plans/july-30-meeting.md` — surface this in every response.

## Goal

Work through the bug reports and feature requests that came out of the **July 30,
2026 camp meeting**. Bugs first (they block real campers today), then roster/nav
clarity, then new features.

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\CampTool`, branch `master`.
- Live deploy: `https://camptool.mathcamp.us` (firefly). Every push to `master`
  auto-deploys; **verify the change is actually live** (see the parent plan's
  false-green deploy gotcha — `/_version` check now makes non-swaps loud).
- Dev server port: **17923** (never 3000/5173).
- **Migration head at task start: `0064`** (all committed). Mine start at `0065`.
- Working tree at task start: 7 files showed as modified but `git diff --numstat`
  was EMPTY — pure CRLF line-ending churn, not another thread's work. The tree is
  effectively clean.
- Feature registry (`app/lib/features.ts`) currently has 16 keys: announcements,
  bringing, documents, dues, finances, map, onboarding, passes, programming,
  questions, recruiting, roster, schedule, supplies, tickets, training.

## Hard constraint (user, this task)

> "Ask before making schema changes that would require migrating existing member
> data — there are **~25 real campers already in the system** and the **burn is
> Aug 30**, so don't break the live roster."

Today is **2026-07-31** → **~30 days to the burn**. This is a real deadline and it
drives sequencing: things campers need *before* they drive to the playa outrank
polish. Anything touching `membership` / `attendee` / roster data needs an
explicit go-ahead and a migration verified on a VACUUM-INTO copy of the live DB
first.

## The 11 items (as reported)

**Bugs (fix first)**
1. Deleting a duplicate member returns a server error. Camper signed up twice
   (couldn't log in the first time, re-registered from scratch). Consider whether
   **merge** beats delete, since either record may have vehicles/tents/placements.
2. No way to remove a person from someone else's "+N guest" group. A guest who now
   has their own account is still a plus-one under another member → double-counted.
   Need admin (and ideally self) detach.
3. Mobile usability poor — a camper couldn't zoom or read the onboarding flow on a
   phone and switched to a laptop. Audit onboarding + roster at small viewports.

**Roster / navigation clarity**
4. "Members" (year-over-year people) vs "Who's Coming 2026" (this year's roster) is
   confusing — people clicked the wrong one live in the meeting.

**New features**
5. Guest→member invite links, per guest, converting the plus-one slot into a real
   member record on signup (not both). A per-person invite mechanism exists but is
   confusing — make it discoverable + complete.
6. Extra tickets & vehicle passes board — "have one / need one", asking price,
   mark claimed. **Ticket and vehicle pass are separate item types.** Requested
   two meetings running; currently ad hoc over Discord/email/DMs.
7. Fuel inventory — who brings fuel, type (gasoline/propane/diesel), how much, in
   what containers. Feeds the map's fuel-storage area + a safety review (secondary
   containment, separation from living areas/ignition sources) → totals and
   container counts matter. Related: capture whether an **RV needs pump-out/
   cleanout access** so it's placed reachable from the service road/main street.
8. Supplies signup / dedupe — claim what you're bringing (liquor, mixers, soda,
   coolers, dispensers, stoves/burners, shade) showing what's already claimed at
   the point of signup. Warehouse inventory ideally visible alongside.
9. "Near my car" placement preference — per-camper checkbox: tent adjacent to my
   vehicle, or don't care. Surface to whoever arranges the map.
10. Lecture scheduling — speaker, title, day, time in the camp's lecture hall.
    Daily view for transcribing onto a physical sandwich board out front, plus a
    per-day list for inside the hall. **Evaluate whether this belongs in the
    existing events/schedule feature.**
11. Shift signup — daily pie service (cutters, servers, cleanup) across ~8–9 days,
    plus RSVP for pre-burn warehouse work parties. **Pie is at exactly 15:14 daily,
    prep from ~13:00.**

## Findings

### 🔴 ROOT CAUSE (bugs 1 AND 2): the TS schema lies about `ON DELETE`

**The single highest-value finding of this task.** `db/schema/*.ts` declares an
`onDelete` rule on *every* membership/attendee FK. But for a handful of columns,
drizzle-kit emitted the migration as:

```sql
ALTER TABLE `x` ADD `y_membership_id` text REFERENCES membership(id);
```

— **no `ON DELETE` clause**. SQLite therefore stores them as **NO ACTION
(restrict)**. Those tables were never later rebuilt, so the live DB disagrees with
the TypeScript. Confirmed by dumping `PRAGMA foreign_key_list` against
`data/camptool.db`. `PRAGMA foreign_keys = ON` is set (`db/client.server.ts:18`),
so the restrict is enforced.

Columns where the **live DB is NO ACTION but the schema claims otherwise**:

| Table.column | TS claims | Live DB | Introduced by |
|---|---|---|---|
| `membership.invited_by_membership_id` | set null | **NO ACTION** | `0005_panoramic_abomination.sql:17` |
| `map_object.owner_membership_id` | set null | **NO ACTION** | `0004_great_strong_guy.sql:14` |
| `map_object.pending_by_membership_id` | set null | **NO ACTION** | `0008_shallow_wolfpack.sql:1` |
| `camp_invite.promote_attendee_id` | set null | **NO ACTION** | `0063_sharp_agent_brand.sql:1` |

All ~24 other membership/attendee FKs are correct in the live DB.

**Bug 1 explained.** `removeMember` (`members.tsx:287-316`) is a bare
`db.delete(membership)` with **no try/catch**, so an FK rejection escapes as an
unhandled **500**. A duplicate camper who registered, declared a tent/vehicle
(→ `map_object.owner_membership_id`), or ever invited anyone
(→ `membership.invited_by_membership_id`) is therefore **undeletable**. This
matches the report exactly.

**Bug 2 explained.** `removeGuest` (`attendee.server.ts:274`) is likewise a bare
delete with no try/catch. Clicking "Invite to join" on a guest creates a
`camp_invite` row with `promote_attendee_id` → that guest; **Remove then 500s**.
The reported guest "has since created their own account", so an invite almost
certainly exists on their row. Sibling columns (`map_object_occupant.attendee_id`,
`ticket.assigned_attendee_id`, `setup_pass.attendee_id`) had the *same* defect but
were incidentally repaired by later unrelated table rebuilds (0053/0055/0059);
`promote_attendee_id` just hasn't had one yet.

**⚠ `db:generate` will NEVER fix this on its own.** The drizzle snapshot
(`db/migrations/meta/0064_snapshot.json`) *also* records `set null` for all four —
it believes the DB already matches. The repair migration must be **hand-written**
(SQLite 12-step table rebuild for `membership`, `map_object`, `camp_invite`).

Secondary defects found in the same paths (worth fixing alongside):
- `removeGuest` orphans a ticket: `ticket.assigned_attendee_id` goes SET NULL but
  `ticket.status` is left at `assigned`/`purchased` with no assignee.
- `removeGuest` silently deletes a *granted* `setup_pass` (cascade), freeing quota
  with no warning.
- The promotion adoption in `i.$token.tsx:141-158` is **not in a transaction** with
  the membership insert and its result is unchecked — a silently-skipped promotion
  still burns the invite (`useCount++`).
- **No merge-members capability exists anywhere** (repo-wide grep clean).

### Existing surfaces that likely absorb these asks

### Feature registry + nav (how anything new must slot in)

`app/lib/features.ts` holds a 16-key `FeatureKey` union + `FEATURES` catalog
(label, description, `starter?`, `requires?`). Per-camp state lives in the generic
`camp_feature` table — **absence of a row = registry default**, so adding a feature
key needs NO migration; only new *tables* do. Adding a feature end-to-end:

1. `FeatureKey` union + `FEATURES` entry (`app/lib/features.ts`) → appears on
   `/settings` automatically.
2. Add each owned first-path-segment to `ROUTE_FEATURES` (drives the preview banner).
3. Migration only if the feature adds tables (e.g. `0064` created `offering` with
   no `camp_feature` DML).
4. `route(...)` inside the `layout(...)` array in `app/routes.ts`.
5. `await requireFeature(active, "key")` in **both** the loader AND the action.
   Public surfaces (`/c/:slug*`) require the feature fully `on` (preview must not
   publish publicly) and 404 otherwise.
6. `...gated("key", "/path", "Label")` in the `nav` array in `layout.tsx`
   (**merge hot spot** — edit in place, never replace).
7. Respect the flag in Overview cards (`index.tsx`), wizard asks (`wizard.ts`),
   and `/guide` prose.

**Nav is a flat, ungrouped, unsectioned list of ~20 Mantine `NavLink`s** — no
headings, no icons, no dividers. That is the root of item 4: `Members` (core,
always on) and `Who's coming` (roster feature) sit adjacent as two bare labels with
nothing distinguishing "everyone, all years" from "this year's attendees". AppShell:
`navbar={{ width: 220, breakpoint: "sm", collapsed: { mobile: !opened } }}` with a
`<Burger hiddenFrom="sm">`.

Page headers today: `/members` → "Members"; `/roster` → "Who's coming · {year}".

### Existing surfaces that likely absorb these asks

- `fuel-storage` map-object kind already exists (`app/lib/structures.tsx:826`) and
  the map auto-draws BM separation rings (10′ ignition, 20′ liquid↔propane, 50′
  fuel↔fuel). Item 7's inventory should FEED this, not duplicate it.
- No "near my car" concept exists anywhere (grep clean) → item 9 is net-new.
- `supplies` feature + `inventory_category`/`inventory_item` tables exist → item 8
  is likely an extension, not a new feature.
- `schedule` (gathering→occurrence→shift→signup) + `programming` (offerings)
  features both exist → items 10 and 11 probably ride these.

### Item 10 (lectures) → `programming`, NOT `schedule`

`programming` is purpose-built for this and already committed (`a744b0a`,
`e69335c`, migration 0064, feature key defaults **off**):
- `offering` (title, description, kind `lecture|workshop|class|performance|
  discussion|other`, durationMin, status `proposed→accepted`, audience, capacity,
  location, proposer, reviewer/reviewedAt/reviewNote)
- `offering_session` (date, startTime, endTime, location override, status, note)
- `offering_presenter` (attendeeId **or** bare `name` for an outside speaker, role
  label, sortOrder)
- Routes `/programming`, `/programming/:offeringId`, and a **public**
  `/c/:slug/schedule` grouped by day (404s unless the feature is fully `on`).

So speaker / title / day / time / venue **all already exist**. "Lecture hall" is
just `location` free text. Public iff `status=accepted` AND `audience=public` AND
≥1 scheduled session.

**Gap for item 10:** there is no *sandwich-board daily view* and no *per-day list
for inside the hall* — i.e. no print/day-sheet output. That's the actual net-new
work, plus possibly a `location` filter. Also `offering_session` has no
title/description override, so "one speaker, a different talk each day" = one
offering per talk (arguably correct modelling).

`schedule` is the wrong home: it has **no speaker/presenter field at all**, no
per-occurrence description, and `gathering_signup.membershipId` is a hard FK to
`membership` (members only, no guests, no public audience).

### Item 11 (shift signup) → `schedule`, model fits, UI does not

The data model handles pie service cleanly: `15:14` is a valid `HH:MM`, daily
recurrence materializes real occurrence rows (`dailyDatesBetween`, capped 100
days), and `gathering_shift.role` + `staffing` (`all_hands|open|needed`) +
`capacity` → waitlist covers cutters/servers/cleanup.

**The blocker is purely UI:** `createGathering` creates exactly ONE shift per
occurrence, and `addShift` adds **one shift to one occurrence per submit**. Three
roles × nine days = **27 manual form submissions**. There is no shift template, no
"apply to all days", no bulk shift creation anywhere. Net-new work = a bulk/
template shift creator, not schema.

Work-party RSVP at the warehouse is already covered (`kind: work_party`, and
`schedule.tsx:506` literally placeholders "e.g. The warehouse / camp HQ").

### Item 8 (supplies) → `supplies` exists; three real gaps

`inventory_category` (camp-scoped) + `inventory_item` (edition-scoped: name,
quantity, `ownerMembershipId` nullable = unclaimed, notes, sortOrder). Claim /
unclaim / officer assignOwner all work; category headers show `{claimed}/{total}
covered`. Gaps vs the ask:
1. **Claiming is all-or-nothing.** `ownerMembershipId` is a *single* nullable FK —
   two people can't each bring 5 of a qty-10 item, and `{claimed}/{total}` counts
   **rows, not units**.
2. **No dedupe of any kind.** Nothing detects duplicate item names; officer
   "+ Add item" always inserts a literal `"New item"`.
3. **No warehouse / off-season stock concept at all** (grepped `warehouse|
   off-season|stock` — only hit is a placeholder string). Every `inventory_item` is
   bound to one `editionId`, and unlike `bringing` there is no "same as last year"
   copy for supplies.

### Items 7 + 9 (fuel, "near my car") → net-new storage needed

`map_object` columns: `id, campId, editionId, name, kind, ownerMembershipId,
placed, x, y, width, height, rotation, tallFt, showDoor, mirrored, config,
groupId, color, notes, pendingByMembershipId, pendingAt, pendingPrev, createdById,
createdAt, updatedAt`.

- **`config` cannot carry this.** It is explicitly a JSON object of **number
  values** keyed by a `CampStructure.controls` entry (`{key,label,min,max,step?,
  default,toggle?}`). No free text. Existing controls include an RV `generator`
  and `cleanout` 0/1 marker — but those are *placement markers* for noise/exhaust
  direction, **not** a fuel record or a pump-out access request.
- **`notes` exists but is unreachable from Bringing** — `bringing.tsx`'s
  `updateItem` only accepts `width`, `height`, `name`. Notes are officer-map-only.
- A camper declares only **kind, name, width, height**. No fuel type/quantity/
  container fields anywhere.
- **Adjacency: nothing declarative.** `groupId` means "these move together" (an
  officer multi-select), not "please place near". So item 9 is genuinely net-new.

### Bug 3 (mobile): the viewport meta is FINE — `touch-action: none` is the culprit

`app/root.tsx:51` is `<meta name="viewport" content="width=device-width,
initial-scale=1">`. Repo-wide grep for `maximum-scale` / `user-scalable`: **zero
matches**. So pinch-zoom is not blocked by the meta tag.

**What actually blocks zoom:** `touchAction: "none"` with no replacement pinch
handler —
- `app/routes/dashboard/map.tsx:6412` (main map SVG) and `:7817` (compass). Grep
  for `pinch|touches|gesturestart|onTouch` in map.tsx: **no matches**. Zoom is
  only reachable via the `+`/`−` ActionIcons at `:6395`.
- `app/routes/dashboard/onboarding.tsx:294` — drag handles. **This is the
  onboarding page the camper reported.**
- `app/routes/dashboard/questions.tsx:675` — drag handles.

Other small-viewport defects found (the mobile plan claims "every `<Table>` is
wrapped in a `Table.ScrollContainer`" — **that claim is wrong**):
- Bare `<Table>` (horizontal overflow): `admin.tsx:412`, `editions.tsx:323`,
  `dues.tsx:345`, `training.tsx:417`.
- **Header overflow at 360–390px**: `layout.tsx:222` `Group gap="md"` holds a
  `Select w={180}` camp switcher + `Select w={130}` year switcher inside
  `Group wrap="nowrap"` (:235) + locked badge + FeedbackButton + user menu —
  ≥310px of fixed-width selects in a non-wrapping row. No `visibleFrom`/`hiddenFrom`.
- **`roster.tsx:255`** guest row: `Group wrap="nowrap"` with a nested nowrap Group
  holding **three** buttons (Invite to join / Edit / Remove), no `minWidth: 0` on
  the text side → compresses/overflows at 360px. This is exactly where items 2
  and 5 add UI, so fix it there.
- `start.tsx:631` Stepper is hardcoded `orientation="vertical"` (mobile-safe, but
  not responsive). Gear-step fixed widths `w={120}`/`w={96}`/`w={96}`
  (`:1053,:1065,:1082`) ≈ 340px — barely fits 360px.
- `plans/accessibility.md` Phase E records axe-verified **`serious` colour-contrast
  failures on dimmed text on every page** — still open.

### Item 5 (guest→member invites): the mechanism exists but is nearly invisible

Per-guest promotion invites **already work end-to-end** and correctly adopt the
attendee row (so RSVP/occupancy/tickets/passes follow — no double record). The ask
is really discoverability + completeness. Current state:

- `getOrCreatePromotionInvite` (`app/lib/invite.server.ts:17-50`) is idempotent —
  reuses any unredeemed, non-revoked invite for that guest; `maxUses: 1`,
  `role: "recruit"`, 192-bit token.
- **The link is shown only in transient fetcher state** (`roster.tsx:307-341`) — it
  **vanishes on navigation/reload**, and nothing on the guest row indicates whether
  an invite was ever generated or redeemed. You must re-click to see it again.
- The trigger is a `size="compact-xs" variant="subtle"` text button buried in the
  "Your party" card on the feature-gated `/roster`, with no explanatory copy.
- `/invite` is a mid-list nav item with no icon/badge; **nothing on the Overview
  points at it**. Its links are generic — a link made there has no
  `promoteAttendeeId`, so redeeming it creates a **second, unlinked attendee row**
  for someone already listed as a guest. That is the "confusing" the meeting hit.
- No share/SMS/email affordance anywhere — raw URL + Copy button only.
- **`/members` has no invite generation at all**; `addRecruit` by email requires an
  existing account ("No account with that email — ask them to sign up first.").

**Separate live defect — the better-auth invitation path dead-ends.**
`recruits.tsx:179-220` calls `auth.api.createInvitation` on accepting an applicant
with no account. But no `sendInvitationEmail` is configured anywhere (grep clean),
better-auth's default just `console.log`s it, and **no accept route exists** (the
`invitation` table is written but never read). The officer sees "Invited alex@… to
join as a recruit" and the applicant is **told nothing and has no way in**. This is
already logged as open question #1 in `plans/whos-coming-attendees.md`, with the
recommendation to swap it to the same `camp_invite` link mechanism.

Also: `useCount` is bumped after the membership insert, **not transactionally**,
with no unique guard — concurrent redemptions of a `maxUses: 1` link could both pass.

## Decisions already made (don't re-ask)

Locked by the user 2026-07-31:

1. **Duplicate members → fix delete AND build merge.** Repair the FK rules so
   delete works, *and* add a merge tool (pick the surviving record, re-point
   vehicles/tents/placements/tickets/RSVP off the stale one, then delete it).
   Reason: either record may hold real data, so merge is the only lossless answer,
   and nothing like it exists today.
2. **The live FK-repair migration is approved** — proceed once it verifies clean
   on a DB copy; no second checkpoint required. Verification bar: apply to a
   `VACUUM INTO` copy, `PRAGMA foreign_key_check` clean, and before/after row
   counts identical on every rebuilt table.
3. **Scope before Aug 30 = bugs 1–3 + nav clarity #4 + #9 + #10 + #11 + #7.**
   **DEFERRED past the burn: #5 (guest invite discoverability), #6 (tickets/passes
   board), #8 (supplies dedupe).** Design notes for all three stay in this plan.

   *Note on how this was decided:* the first pass asked this with items bundled in
   pairs and returned "#6 + #5". Re-asked unbundled, the answer was "#10 and #9
   are most important" / "#11, #7". The unbundled answer wins — the bundling
   forced a false choice. The chosen set is coherent: fuel, tent placement,
   lecture schedule and work shifts are all *get the camp organised before we
   drive out there*; #5/#6 are people-admin that can slip past the event.

4. **Warehouse inventory → PULL bins data into the supplies view.** Fetch from the
   bins tracker (`i.mathcamp.us`) and show real counts inline at the point of
   claiming, rather than linking out or re-modelling stock. **Open dependency:
   does the bins tracker expose an API?** — must confirm before building #8.
   This couples the two apps at runtime, which supersedes the earlier
   "no code sharing" stance for *data* (still no shared code). #8 is deferred, so
   this is not blocking.

## Build order

**Before the burn:**

1. **Migration 0065 — FK repair** (hand-written rebuild of `membership`,
   `map_object`, `camp_invite`). Unblocks bugs 1 AND 2 at the root.
2. **Harden the delete paths** — `removeMember` and `removeGuest` get real error
   handling instead of a bare delete; `removeGuest` also resets an orphaned
   ticket's `status` and warns about a granted setup pass.
3. **Merge members** (decision 1).
4. **Bug 2 UI** — detach a guest, for the host and for officers.
5. **Nav clarity (#4)** — distinguish Members vs Who's Coming.
6. **Mobile (#3)** — `touch-action`, the four bare tables, header overflow,
   the roster guest row.
7. **#9 near-my-car** (smallest of the four features; one preference + surfacing).
8. **#7 fuel inventory + RV pump-out access.**
9. **#10 lecture day sheet** (sandwich board + in-hall per-day list).
10. **#11 bulk shift builder** (pie service ×9 days, work parties).

**Deferred (design notes only):** #5, #6, #8.

## Next up — design notes for the four remaining before-burn features

All four are net-new work; none is blocked. Migration numbering starts at
**0066** (0065 is the FK repair). Remember: adding a `FeatureKey` needs **no**
migration (absence of a `camp_feature` row = registry default); only new tables do.

### #9 "Near my car" — ✅ DONE (2026-07-31, migration 0066)

Shipped as a per-**domicile** boolean rather than a bare per-camper flag: the
useful question is *which* thing goes next to the car, and most campers have one
tent so it reads the same, while a camper with two structures can answer for each.

- `map_object.place_near_vehicle` (migration **0066** — a single clean `ALTER`,
  no FK involved, so none of the 0065 trap applies). Default `false` = "don't
  care", which is the honest default given campers who cluster vehicles and
  pitch tents elsewhere.
- Checkbox on `/bringing`, shown **only on `group === "Domiciles"`** — asking
  whether a car should be parked next to a car isn't a question. Required a new
  `updateItem` branch, since that action previously accepted only
  `width`/`height`/`name` (the same reason `map_object.notes` is still
  unreachable from Bringing).
- **Carried through "bring these again"** — the preference is as stable year to
  year as size/config, so re-declaring keeps it.
- Surfaced to whoever arranges the map in **both** places they'd look: a "near
  their vehicle" badge on `/inventory`, and a compact "near car" badge in the
  map's **Unplaced tray**, which is where placement actually happens.
- Deliberately advisory — nothing auto-places. The ask was to *show* the
  preference. Distinct from `groupId` ("these move together", an officer-side
  multi-select).
- Verified on a `VACUUM INTO` copy: rows 6 → 6, column `INTEGER notnull=1
  default=false`, all existing rows default to don't-care, round-trip write
  works, `foreign_key_check` clean. typecheck + build + biome green.
  NOT browser-tested.

### #9 "Near my car" — original design note (superseded by the above)

One per-camper, per-item preference surfaced to whoever arranges the map.
- **Storage:** `map_object` already has a `config` JSON column but it holds
  **numbers only** (`{key,label,min,max,step?,default,toggle?}` controls), so a
  new boolean fits as a `toggle` control — *but* controls are per-`CampStructure`
  and this is a placement *preference*, not a structure setting. Cleaner: a
  nullable `place_near_vehicle` integer(boolean) column on `map_object`, set on
  the camper's **tent**, meaning "put this next to my car".
- **Where to collect:** `/bringing` — note `updateItem` currently accepts only
  `width`/`height`/`name`, so it needs a new branch (this is also why
  `map_object.notes` is unreachable from Bringing today).
- **Where to surface:** `/inventory` (the officer accounting table) and the map's
  unplaced tray — a small "near car" chip. Don't auto-place; the ask is only to
  *show* the preference to the person arranging.

### #7 Fuel inventory + RV pump-out

- **Storage:** a new `fuel_declaration` table (camp + edition scoped): owner
  membership, `fuelType` (gasoline | propane | diesel), quantity + unit
  (gal/lb), container type + count, notes. A per-camper row set, not a
  `map_object` — the map already has a `fuel-storage` **kind** that auto-draws
  the BM separation rings (10′ ignition / 20′ liquid↔propane / 50′ fuel↔fuel,
  `structures.tsx:822-836`); this feature **feeds** that, it does not replace it.
- **Why it matters:** surfacing **totals per type and container counts** for the
  safety review (secondary containment, separation from living areas and
  ignition sources).
- **RV pump-out** is a separate, simpler thing: a boolean on the RV `map_object`
  ("needs pump-out / cleanout access") so it gets placed reachable from the
  service road or main street. Note `structures.tsx` already has a `cleanout`
   0/1 **marker** control — that is a *drawing* marker for where the fitting is,
  NOT an access requirement. Don't conflate them.
- New feature key `fuel`, default off.

### #10 Lecture scheduling — ✅ DONE (2026-07-31, no migration)

Confirmed the evaluation: this belonged in `programming`, which **already** had
speaker / title / day / time / venue. **No schema change was needed** — the only
gap was output.

- `loadDaySheet(campId, editionId)` in `programming.server.ts` — like
  `loadPublicLineup` but **does not filter on `audience`**, because a camp-only
  session still occupies the lecture hall and still belongs on the list posted
  inside it. Each row carries `isPublic` so the sheet can flag what shouldn't go
  on the sign out front.
- New route **`/programming/board`** (declared before `programming/:offeringId`
  so the static segment wins). Two modes off one page:
  - **Sign** — one day, big type, minimal words, for hand-transcribing onto the
    sandwich board out front.
  - **Handout** — same day plus descriptions, for posting inside the hall.
- Day nav (prev / each date / next), `?date=` + `?mode=` in the URL so a sheet
  is linkable. Defaults to **today** when the event is running, else the first
  day.
- Print-first: a `@media print` block drops the app chrome (nav, header,
  banners) so `Print` yields something tapeable. Linked from `/programming`.
- **Verified by actually rendering it** (SSR + memory router) against seeded
  offerings: day nav lists all three dates, `?date=` selects correctly, handout
  shows descriptions while sign omits them, the "camp only" badge appears, times
  format as "2 pm – 3 pm", and presenters render across **all three** join paths
  (member attendee, camp guest, bare outside name).
- Gotcha for future tests: the dev DB has **three editions all with year 2026**
  and multiple camps, so `SELECT ... LIMIT 1` without `ORDER BY` picks a
  different one per run — anchor test fixtures to a known row instead. Also note
  the real `audience` value for non-public is **`camp_only`**, not `camp`.

### #10 — original design note (superseded by the above)

`programming` already models everything: `offering` (title, kind `lecture`,
description, location, status), `offering_session` (date, start/end time,
location override), `offering_presenter` (member via attendee, camp guest, **or
a bare outside-speaker name**), plus a public `/c/:slug/schedule` grouped by day.
- **The only net-new work is output**: (a) a **sandwich-board day sheet** —
  one day, big type, print-friendly, for transcribing onto the physical board out
  front; (b) an **in-hall per-day list**. Add a `?date=` + print stylesheet view.
- Probably also a `location` filter so "the lecture hall" can be isolated.
- **Do not** use the `schedule` feature for this: it has **no speaker field at
  all**, no per-occurrence description, and `gathering_signup.membership_id` is a
  hard FK to `membership` (members only, no public audience).
- Caveat: `offering_session` has no per-session title, so "same speaker,
  different talk each day" = one offering per talk. That's correct modelling.

### #11 Shift signup — the schema is fine, the UI is the blocker

Pie service at **15:14 daily** with prep from **~13:00**, roles cutter / server /
cleanup, across ~8–9 days; plus warehouse work-party RSVP.
- `15:14` is a valid `HH:MM`; daily recurrence already materializes real
  occurrence rows (`dailyDatesBetween`, capped 100 days); `gathering_shift.role`
  + `staffing` (`all_hands|open|needed`) + `capacity` → waitlist covers the roles.
  Work parties already exist as `kind: work_party`.
- **The blocker:** `createGathering` makes exactly ONE shift per occurrence, and
  `addShift` adds one shift to **one** occurrence per submit. Three roles × nine
  days = **27 manual form submissions**. Build a **bulk/template shift creator**:
  define the roles once, apply to every occurrence in the range. No schema change.

## Merge design (bug 1 + bug 2)

`app/lib/merge.server.ts`. Both duplicate shapes reduce to one primitive:
re-point every row referencing the stale id at the survivor, then delete the
stale row.

- **The FK reference list is derived at runtime** from `PRAGMA foreign_key_list`
  over every table, not hardcoded — a table added later is covered without
  anyone remembering to update the merge code.
- The sweep uses **`UPDATE OR IGNORE`**. Where a unique constraint means both
  people already have the equivalent row (both answered a question, both signed
  up for a shift), the stale row can't move; it's left behind and cleaned up by
  the FK rules when the stale record is deleted. **This deliberately leans on
  migration 0065** — before that repair, merge could not have worked either.
- `attendee` is reconciled **per edition before** the generic sweep (both rows
  for the same year must become one body, or the roster still double-counts).
  Guests hosted by the duplicate are re-hosted onto the survivor.
- The survivor keeps its own role and identity; **only blank fields** are filled
  in from the duplicate, so a merge never silently downgrades or renames anyone.
- Merge requires the same authority as removal (strictly outrank the record
  being absorbed) and refuses to merge your own account away.
- `claimGuestAsMember` is the bug-2 self-service path and is **deliberately not
  gated on being the host** — the point is the person resolves it themselves.
  Trust assumption noted in code: a member won't claim a stranger's entry to
  take their ticket; officers can see and undo the result.

## Open questions for the user

*(none blocking — all four gating questions answered above)*

## Progress log

- [x] 2026-07-31 — read parent plan + camp-features/whos-coming plans; mapped
      routes, schema files, feature keys, migration head; confirmed the working
      tree is CRLF-noise-only. Plan created.
- [x] **Nav clarity (#4) + the concrete mobile defects (#3).** 2026-07-31.
      - Nav labels are now self-describing instead of two bare adjacent words:
        **"Members · all years"** and **"Who's coming · 2026"** (year comes from
        the active edition, so it tracks the year switcher). Each page also
        gained a one-line description + a link to the other, so landing on the
        wrong one self-corrects.
      - **Pinch-zoom unblocked.** `touch-action: none` on the map SVG and
        compass (`map.tsx:6412`, `:7817`) killed native pinch with no
        replacement gesture — zoom was `+`/`−` buttons only. Now
        `touch-action: pinch-zoom`, which still suppresses the pan/scroll
        gestures that fight with dragging objects. **The viewport meta was
        never the problem** (`root.tsx:51` is correct; no `maximum-scale` or
        `user-scalable` anywhere in the repo).
      - **Four `<Table>`s wrapped** in `Table.ScrollContainer` (`admin.tsx`,
        `editions.tsx`, `dues.tsx` first table, `training.tsx`) — these
        overflowed horizontally on a phone. `plans/mobile-support.md` claims
        "every `<Table>` is already wrapped"; **that claim was wrong** and is
        now true.
      - **Header no longer overflows at 360px** — the camp + year Selects were
        180px + 130px inside a non-wrapping row; both are now responsive
        (`{ base: 120, sm: 180 }` / `{ base: 104, sm: 130 }`) and the row wraps.
      - Roster guest chips render in a **wrapping** Group (was part of the same
        overflow class).
      typecheck + build + biome green.
      ⚠️ **NOT browser-tested at a real small viewport** — these are structural
      fixes to concrete, identified defects, but the authenticated pages still
      need the visual pass that `plans/mobile-support.md` step 5 has been
      blocked on. Worth 10 minutes on an actual phone before the burn.
- [x] **Merge + hardened deletes (bugs 1 + 2 fixed end-to-end).** 2026-07-31.
      `app/lib/merge.server.ts` (see design above) + UI:
      - `/members`: a **Merge** button per editable row → modal that picks the
        surviving member and shows a **live preview of exactly what will move**
        ("6 records: 2 × map object, 1 × question answer, …") before committing,
        since the operation deletes a record. Officer+, rank-checked.
      - `removeMember` / `removeGuest` no longer bare deletes — both catch and
        return a **409 with a useful message** instead of an unhandled 500, and
        the member one points at Merge, which is usually what was actually
        wanted.
      - `removeGuest` now **releases the guest's ticket back to the pool**
        (previously it stayed `assigned` with a NULL assignee — invisible to the
        officer's available count and un-reassignable) and **reports granted
        setup passes** it cascaded away instead of silently freeing quota.
      - `/roster`: guests render as chips in a **wrapping** Group (was a source
        of the mobile overflow in bug 3), and anyone who isn't the host gets a
        **"That's me"** button → confirm modal → `claimGuest`, folding the
        plus-one into their own account so the roster stops double-counting.
      Verified by seeding a realistic duplicate on a fresh migrated DB and
      running the real functions: **14/14 assertions** on the membership merge
      (gear moved, no gear orphaned, invite edge re-pointed, one attendee row
      for the year, ticket + tent spot followed the surviving body, guest
      re-hosted, survivor's own answer kept over the duplicate's, colliding
      duplicate dropped, blank playa name backfilled, `foreign_key_check`
      clean) and **11/11** on guest-claim across both branches (claimer with no
      attendee row → promoted in place keeping their tent spot; claimer with an
      existing row → folded together, headcount −1, ticket moved). Headcount
      went 3 → 2 exactly as intended. typecheck + build + biome green.
- [x] **Migration 0065 — FK repair (bugs 1 + 2 root cause). VERIFIED, committed.**
      Hand-written rebuild of `membership`, `map_object`, `camp_invite` fixing
      **five** wrong `ON DELETE` rules (the fifth, `map_object.edition_id`, was
      found during the rebuild — NO ACTION in the DB vs `cascade` in the schema,
      so deleting a *year* would also have failed).

      **The enabling fix is in `db/client.server.ts`, not the migration.**
      Migrations run inside an explicit transaction
      (`sqlite-core/dialect.cjs:676` `session.run(sql\`BEGIN\`)`), and SQLite
      **ignores `PRAGMA foreign_keys` inside a transaction** — so the
      `PRAGMA foreign_keys=OFF` that drizzle-kit emits at the top of every
      generated table rebuild has never actually done anything. It didn't matter
      before because the previously-rebuilt tables (`setup_pass`,
      `map_object_occupant`) had nothing referencing them. `membership` has **27
      inbound FKs**. So the pragma now toggles around `migrate()` at the
      connection level, where it takes effect, and a `PRAGMA foreign_key_check`
      assertion refuses to boot on violations.

      Verification (scripts kept at `%TEMP%\camptool-fkverify\`):
      - Seeded the exact hazard on a `VACUUM INTO` copy — self-referential
        `invited_by` edge, `map_object` owner + pending-edit, a guest attendee
        with a promotion invite pointing at it.
      - **All row counts identical** across all 54 tables (only
        `__drizzle_migrations` 65→66). `foreign_key_check` clean.
      - All five rules now read correctly from `PRAGMA foreign_key_list`.
      - **Bug 1 reproduced as fixed:** deleting a member who both invited someone
        and owns a map object now succeeds; the 6 map objects survive with
        `owner`/`pending` set NULL (gear preserved, not cascaded), and the
        invitee's `invited_by` goes NULL.
      - **Bug 2 reproduced as fixed** (isolated run): deleting a guest with a
        promotion invite succeeds; the invite row survives with
        `promote_attendee_id` NULL.
      - Fresh install chain 0000→0065 applies clean on an empty DB (54 tables).
      - `db:generate` reports "No schema changes" → snapshot 0065 is consistent.
      - typecheck + build green; biome clean on changed source. (Remaining lint
        failures are only drizzle's auto-generated snapshot JSON — pre-existing,
        `_journal.json` already failed format at HEAD.)

      **Control run (documented so nobody "simplifies" the pragma away):** with
      foreign keys left ON during migrate, `DROP TABLE membership` **throws and
      the whole migration rolls back** — it fails loudly rather than silently
      deleting (the NO ACTION FKs block the implicit `DELETE FROM`). No data
      loss, but the app would refuse to start. The pragma toggle is load-bearing.

      ⚠️ Pre-deploy verification used the LOCAL dev DB (4 memberships / 6 map
      objects), not the firefly production DB (~25 campers). Schema chain is
      identical, so the structural result is the same, but the row-count check
      was only as representative as local data.

      **DEPLOYED + PRODUCTION-VERIFIED (commit `d61bc46`).** Deploy to firefly
      green in 48s including the `/_version` SHA gate, and
      `https://camptool.mathcamp.us/_version` returns exactly `d61bc46…` — so
      this is a real swap, not the known false-green. `/login` returns **200 and
      renders SSR content**, which requires `db/client.server.ts` to have loaded
      — meaning **migration 0065 applied to the production DB and the new
      `foreign_key_check` assertion passed on real data**. If the rebuild had
      lost or dangled anything, the module would have thrown and the route
      would 500.

      Gotcha for future sessions: `curl -o /dev/null -w '%{http_code}'` against
      this host intermittently reports `000` at ~0.06s due to a local
      schannel TLS-renegotiation quirk on Windows. The server is fine — confirm
      with `curl -v` before concluding an outage.

      ⚠️ **Side effect of the push:** remote `master` was at `9b16e90`, but local
      `master` already carried two unpushed commits from a *different* session
      (`a744b0a` "Programming: camp offerings", `e69335c` "Programming: README
      section"). Pushing my commit necessarily published and deployed those too.
      Nothing was overwritten or lost, but that Programming work went live
      earlier than its author may have intended.

## Things not to do

- Don't migrate `membership` / `attendee` data without explicit per-change
  approval — the live roster has ~25 real campers and the burn is 30 days out.
- Don't add a second "supplies"/"schedule"/"fuel" system beside the existing
  features; extend what's there (the parent plan's repeated lesson).
- Don't use HTML `title=` tooltips (global rule) — the mobile audit should REMOVE
  any it finds, since they're invisible on touch.
- Don't assume a single camp; every tenant table carries `camp_id`.
