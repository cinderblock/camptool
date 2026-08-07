# Roster ↔ map linkage — "where is this person camped?"

> Task plan. Parent living plan: `plans/camptool.md`. Sibling:
> `plans/whos-coming-attendees.md` (the roster itself).

## Goal (user ask, 2026-08-07)

From `/roster` you can see *who* is coming and *when* they arrive, but not
*where* they are camped. Close that gap in two steps: a per-row link into the
map, then an embedded mini-map that highlights a person's structures in place.

## Decisions already made (don't re-ask)

- **Ship both, in order (user, 2026-08-07):** the per-row map link first as its
  own commit, then the embedded mini-map as a follow-up. The link is a
  prerequisite either way — both need "which map objects belong to this
  attendee".
- **Highlight the whole party (user, 2026-08-07):** a row lights up the member's
  own structures *plus* anything their guests occupy. Matches how the roster
  already groups people and answers "where is this household camped?".
- **Selection, not hover.** Hover must never be the only channel — the user is
  frequently on iOS, where a hover-only highlight simply does not exist. The
  interaction is: tap/click a row to select (tap again to clear), with hover as
  a progressive enhancement on pointer devices. Same rule that bans `title=`
  tooltips in this repo.

## Environment / findings from recon (2026-08-07)

- `/map` is **one 10,093-line file**, `app/routes/dashboard/map.tsx`, rendering
  **SVG**. There is no `<CampMapView>` component — the `<svg>`, lot, zoom/pan
  frame, gestures, zones/cables/roads all live inline in `Editor`
  (`map.tsx:4367`, ~3,200 lines, ~50 props). Only `MapObjectShape`
  (`map.tsx:8197`) is cleanly separable and pure: pass
  `editable/resizable/rotateArmed = false` and no-op handlers for a read-only
  draw. **This is what makes Phase 2 expensive, and why Phase 1 goes first.**
- **A person attaches to a map object two different ways.** Owner is
  `mapObject.ownerMembershipId` → `membership.id` (`db/schema/map.ts:87`, NULL =
  camp/shared). Occupants are `mapObjectOccupant.attendeeId` → `attendee.id`
  (`db/schema/map.ts:154-180`). So "this party's objects" is a union across two
  different key types, and guests can only ever appear via the occupant side.
  `RosterGuest.id` already **is** the `attendee.id`, so the roster has the right
  key in hand.
- Only `mapObject.placed` objects render (`db/schema/map.ts:93`); unplaced ones
  are the officer queue.
- **No URL param, hash, or `useSearchParams` exists in `map.tsx` at all** —
  nothing anywhere links to `/map` with any parameter. The deep link is new
  surface.
- There IS an existing dim-everything-else mechanism to build on: `highlight`
  state (`map.tsx:3544`, values `none|mine|domicile|vehicle|structure`), matched
  at `map.tsx:4635` and applied as `dim={...}` per shape (`map.tsx:6974`).
- Programmatic selection is already supported (`setSelectedId` +
  `setSelectedIds` on create, `map.tsx:3675`), but **there is no pan-to/center-on
  helper** — that has to be built. Reusable pieces: the selection centroid
  (`map.tsx:5270-5292`) and the `pendingScroll` write (`map.tsx:4467`).
- **The map loader does not load occupants at all** (`objSelect`,
  `map.tsx:693`, only joins `ownerName`). So "who sleeps where" is currently
  invisible on the map. Resolve the party server-side from the query param
  rather than loading occupants for every map render.
- The roster loader has nothing map-related today
  (`roster.tsx:52-72`, `attendee.server.ts` imports no map schema).

## Design (Phase 1)

- URL is `/map?party=<membershipId>` — human-meaningful, stable, shareable in
  Discord. NOT a list of object ids: those go stale and make an unreadable URL.
- The map loader resolves `party` server-side into a set of object ids (owner
  membership match ∪ occupant-attendee match over the member + their guests),
  only when the param is present — so the common map load pays nothing.
- The map shows an explicit "showing X's party / clear" affordance, so a dimmed
  map is never unexplained.
- The roster only renders the link for a party that actually has placed objects,
  so there are no dead links.

## Open questions for the user

*(none right now)*

## Progress log

- [x] Design fork settled with the user (scope + what lights up + no hover-only).
- [x] Recon — see Environment above.
- [x] **Phase 1 — per-row map link. DONE + browser-verified, 2026-08-07.**
  - `app/lib/party-map.server.ts` — `partyMapObjects(editionId)` returns every
    party's placed objects keyed by host membership, unioning the owner and
    occupant sides and rolling a guest's occupancy up to their host. Uses Sets,
    so someone who both owns a tent and is listed as its occupant counts once.
    One code path shared by both surfaces so they can't disagree.
  - Roster: a **Where** column — `N on map` linking to `/map?party=<id>`, or
    "not placed". Whole column hidden when the camp's `map` feature isn't
    visible to the viewer (`getFeatureState` + `featureVisibleTo`).
  - Map: loader resolves `?party=` via `resolveParty` (camp-scoped — a foreign
    or malformed id yields a normal map, not an error, and can't probe another
    camp's memberships). Adds a `party` highlight mode reusing the existing
    `highlight`/`dim` mechanism, a **Party** segment in the Highlight control,
    and an Alert naming whose party is shown with "Show everyone" + "Back to
    Who's coming".
  - **No pan-to was built, deliberately:** zoom 1 already fits the whole lot in
    the frame, so at the default view the highlight alone locates people and a
    scroll helper would be dead code. Revisit only if the map gains a default
    zoomed-in state.
  - Verified in-browser on a seeded copy of the live DB, with the counts chosen
    to catch the ways this can go wrong: Ada **3** (own tent + own shade + her
    guest's tent, which she does not own), Grace **1** (owner *and* occupant —
    deduped, not 2), Alan **1** (occupant of a tent nobody owns), Emmy **not
    placed** (her only object is unplaced). Then: the deep link dims everything
    else and preselects Party; "Show everyone" clears it; an empty party says
    "isn't on the map yet" instead of showing an unexplained all-dimmed map; a
    bogus id renders a normal map with no Party segment; and turning the map
    feature off removes the column entirely.
  - typecheck + build green; lint/tests clean for these files (the repo also had
    failures from a peer thread's unregistered `swaps.*` route at the time).
- [ ] Phase 2 — embedded mini-map with row selection.

## Things not to do

- Don't make hover the only way to reveal the highlight (see Decisions).
- Don't add a `title=` attribute to the link or any map object.
