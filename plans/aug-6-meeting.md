# Aug 6 camp meeting — remaining bugs + feature requests

> Task plan. Parent living plan: `plans/camptool.md`. Predecessor:
> `plans/july-30-meeting.md` (items 1–11 were triaged there; several shipped).
> Plan path: `plans/aug-6-meeting.md` — surface this in every response.

## Goal

Close out the combined July 30 + Aug 6, 2026 meeting backlog. The July 30 pass
already shipped bugs 1/2, nav clarity, the mobile structural fixes, "near my
car", and the lecture day sheets. This pass covers what is left plus three new
Aug 6 items (agenda emptiness, "what is a shift?", arrival distribution).

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\CampTool`, branch `master`.
- Live deploy: `https://camptool.mathcamp.us` (firefly), auto-deploys on push to
  `master`. **This task does not push.**
- Dev server port **17923**. Scripts: `bun run typecheck | lint | test | build`.
- **Migration head at task start: `0066`.** Mine start at **0067**.
- ~25 real campers live; burn is **Aug 30, 2026** → ~23 days out.
- Working tree at task start was NOT clean: an in-flight roster change
  (day-of-week arrival/departure chips, `app/lib/arrival.ts`, hide not-coming)
  plus `biome.json` (ignore `db/migrations/**`) and `@types/node`. Safety
  snapshot taken (`git stash store`, "safety: pre-aug6-meeting-work snapshot").
  That work is item 14's foundation and is finished + committed here.

## Hard constraint (user, this task)

> No schema changes that would require **migrating existing member data**
> without stopping and reporting first. Implement what is safely possible, skip
> the risky part, flag it.

Reading applied: **adding a new table is safe** (nothing existing moves), and an
**additive `ALTER TABLE ... ADD COLUMN` with a default is safe** (the 0066
`place_near_vehicle` precedent). **Rewriting or re-homing existing
`membership` / `attendee` / `inventory_item` rows is NOT** and is out of scope.

## Status of the 14 items

| # | Item | State |
|---|---|---|
| 1 | Duplicate member delete 500 | ✅ shipped (migration 0065 + merge tool) |
| 2 | Detach a +N guest | ✅ shipped (`claimGuestAsMember`, hardened `removeGuest`) |
| 3 | Mobile usability | 🟡 mostly shipped; drag-handle `touch-action` left |
| 4 | Members vs Who's Coming | ✅ shipped |
| 5 | Guest→member invite links | 🟡 mechanism works; discoverability gap |
| 6 | Extra tickets / vehicle passes board | ❌ net-new |
| 7 | Fuel inventory + RV pump-out | ❌ net-new |
| 8 | Supplies signup with dedupe | ❌ net-new |
| 9 | "Near my car" | ✅ shipped (migration 0066) |
| 10 | Lecture scheduling | ✅ shipped (`/programming/board`) |
| 11 | Shift signup (pie service) | ❌ schema fits, UI is the blocker |
| 12 | Agenda empty and confusing | ❌ new (Aug 6) |
| 13 | "Shifts" undiscoverable | ❌ new (Aug 6) |
| 14 | Arrival-date distribution | 🟡 in-flight in the working tree |

## Decisions already made (don't re-ask)

Carried from `plans/july-30-meeting.md` (still binding): merge beats delete for
duplicates; lectures belong in `programming`, not `schedule`; extend existing
features rather than adding parallel systems; every tenant table carries
`camp_id`; no HTML `title=` tooltips.

New for this pass:

1. **#11 ships as a generic bulk shift builder, not a "pie service" button.**
   The camp's four pie roles (freezer pull ~13:30, slicers 14:15–14:45, servers
   8–12 at 15:14, cleanup 1–2 after 15:20) are *data*, not code — hard-coding
   them would bake one camp into the open-source core, which the parent plan
   explicitly forbids. What was missing is the ability to define a set of roles
   **once** and stamp them across every day of a recurring gathering, plus the
   ability to **edit** a shift afterwards so the server count can ramp up over
   the week. Both are pure UI/server work with no schema change.
2. **#8 ships without restructuring item ownership.** Per-unit claims (two
   people each bringing 5 of a qty-10 item) would mean moving
   `inventory_item.owner_membership_id` into a join table — a migration of
   existing rows, which the constraint forbids. Instead: campers can **add their
   own supply line**, and the add box does live dedupe against what is already
   listed and claimed. Separate rows per person is the honest model for "who is
   bringing what" anyway.
3. **#6 and #7 are new feature keys with new tables** — additive, no existing
   data touched. `swaps` (ticket/pass board) and `fuel`.
4. **RV pump-out is a boolean column on `map_object`**, exactly like
   `place_near_vehicle` in 0066 (additive `ALTER`, defaults false). Deliberately
   NOT the existing `cleanout` control, which is a *drawing marker* for where
   the fitting sits, not an access requirement.
5. **#12 resolves as "hide until it has content", not "seed".** Seeding pie /
   potluck / Little Black Dress into the app would hard-code Math Camp data into
   camp-agnostic core. Instead the Schedule nav entry and Overview card hide
   themselves from non-officers while the year has nothing scheduled, and
   officers get an empty state that says what to create. The camp's real
   recurring events get entered through #11's bulk builder in about a minute.
6. **Warehouse stock stays out of #8.** Decision 4 of the July 30 plan (pull
   counts from the bins tracker at `i.mathcamp.us`) is still blocked on whether
   that app exposes an API. Not blocking the rest of #8.

## Build order

1. #3 leftovers — drag-handle `touch-action` on onboarding + questions.
2. **#11 bulk shift builder + shift editing** (hard deadline).
3. **#13 "what is a shift"** — same surfaces, ships with #11.
4. **#8 supplies self-claim + dedupe** (hard deadline).
5. **#6 ticket / vehicle-pass board** (hard deadline) — migration 0067.
6. **#7 fuel inventory + RV pump-out** (hard deadline) — migration 0068.
7. #14 arrivals-per-day summary (finishes the in-flight tree work).
8. #12 hide the empty agenda.
9. #5 invite discoverability, if budget remains.

## Findings / gotchas

- `createGathering` takes a single `shift?: Partial<ShiftInput>` and stamps one
  shift per occurrence; `addShift` targets exactly one occurrence. There is no
  `updateShift` intent at all — so today the only way to change a shift's
  capacity is delete + re-add, which **destroys its sign-ups**. That is the real
  reason the "ramp servers up over the week" ask was impossible, not the
  bulk-create gap.
- `inventory_item` inserts a literal `"New item"` row from an officer-only
  button; there is no member-facing add path at all. A camper who wants to bring
  liquor genuinely has nowhere to say so — that is the reported bug, not dedupe
  per se.
- All top-level `<Table>`s are now wrapped in `Table.ScrollContainer`
  (re-verified with a script that checks the preceding line); the July 30 fix
  holds.
- `touch-action: none` survives only on the two dnd-kit drag handles
  (`onboarding.tsx`, `questions.tsx`). `pinch-zoom` still suppresses
  pan/scroll, so dragging keeps working — same fix the map got.

## Progress log

- [x] 2026-08-07 — read both plans, mapped current state of all 14 items,
      confirmed 1/2/4/9/10 already shipped. Plan created.

## Things not to do

- Don't hard-code Math Camp's pie/potluck/lecture specifics into core code.
- Don't restructure `inventory_item` ownership (data migration; forbidden here).
- Don't delete-and-recreate a shift to change its capacity — it cascades the
  sign-ups away. Use the new `updateShift`.
- Don't push. Commit only.
