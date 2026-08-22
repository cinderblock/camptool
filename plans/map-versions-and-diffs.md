# Map versions everyone can see, and diffs between them

> Living plan. Plan path: `plans/map-versions-and-diffs.md`.
> Parent: `plans/camptool.md`. Siblings: `plans/map-undo-snapshots.md`
> (where named snapshots came from), `plans/multi-suggestions.md` (where
> per-camper suggestions came from).

## Goal

The camp has a few different layouts in flight and no way to look at them side
by side. Make **every version of the map visible to every member**, and let a
member's own suggestions read as *their* version of the map rather than as
scattered ghosts. Then show what actually differs between any version and the
official map.

## What was already there (grounds the design)

Two half-features that never met:

- **Named snapshots** — `map_snapshot` rows with `kind='named'` hold a full-map
  JSON blob (placement + objects + occupants + zones + cables + roads). The
  loader already ships the *list* to everyone (`map.tsx` loader), but the
  `SnapshotsPanel` was officer-gated and the only verb was **Restore**, which
  overwrites the official map. There was no way to merely *look* at one.
- **Per-camper suggestions** — `map_edit_suggestion`, one row per
  (object, member). Every member already had their own set of proposed
  positions; they just drew as loose ghosts, never gathered into a coherent
  "this is Alice's layout".

## Decisions already made (don't re-ask)

1. **Members propose rearrangements only** (move / resize / rotate of objects
   that already exist). No member-proposed adds, deletes, or zone/road/cable
   edits. Locked 2026-08-21 by the user, and it is what makes the rest of this
   cheap: `map_edit_suggestion` already covers exactly that surface.
2. **No per-member map forks.** The editor is server-row-authoritative — ~25
   intents each writing edition-scoped rows. A member editing their own whole
   map would need a `variant_id` on every map table plus every query filtered,
   or a parallel blob-editing path through a 9.7k-line component. Rejected as
   far more work than the per-object model that already exists, and worse to
   review (approve-everything-at-once instead of item by item).
3. **"Everyone" means every signed-in member.** No public surface — see the
   private-first rule in `plans/camptool.md`.
4. **Officers keep the write verbs.** Save / restore / delete a snapshot stay
   officer-only. Viewing and diffing are for everybody.
5. **No schema change.** Everything below is a read path over tables that
   already exist.

## Model

A **version** is anything that resolves to a full client map state
(`{objects, zones, cables, roads, lot}`). Three sources, one shape:

| Version | Source | Resolved |
| --- | --- | --- |
| `official` | live `map_object` / `map_zone` / … rows | already in client state |
| `snapshot:<id>` | a named `map_snapshot` blob | server, via `viewSnapshot` |
| `member:<membershipId>` | official + that member's suggestion rows | client-side, free |

Because all three land in the same shape, **one read-only viewer and one diff
engine serve all of them**. That is the whole trick — `member:` versions cost
no server work at all, since the client already holds both official geometry
and every suggestion.

## Server

- New `viewSnapshot` intent — **not** officer-only, any member of the edition.
  Reads a named snapshot's blob and returns `{ view: clientMap }`. Pure read:
  no mutation, no undo checkpoint, no history side effects.
  - The blob holds **raw** `map_object` rows, not the `objSelect` shape, so
    resolving it means: filter to `placed || staged` (the `onMap` rule),
    `parseConfig` the config JSON, `parsePending`, and resolve `ownerName`
    through a membership→user lookup the blob doesn't carry.
- Loader is otherwise unchanged: `snapshots` and `suggestions` already go to
  everyone.

## Client

- `viewing` state: which version is on screen (`null` = official/live).
- While viewing a non-official version the Editor renders that state with
  `canEdit`/`canManage` forced false, plus a banner naming the version and an
  exit. The live state is never overwritten — the version is passed *instead
  of* it, so leaving the viewer needs no refetch.
- **VersionsPanel** (all members): Official, each named snapshot, and each
  member who has outstanding suggestions. Officer-only extras (save a new
  snapshot, restore, delete) stay inside the same panel behind `canManage`.
- **Diff** against official, keyed by object id: added / removed / changed
  (geometry differs) + net zone/cable/road deltas + whether the lot changed.
  Shown as a list in the panel and as an overlay on the map — the official
  footprint ghosted where a thing used to be, an arrow to where the version
  puts it.

## Plan / phases

- [x] P0 — Read the existing snapshot + suggestion code; settle the fork with
      the user (rearranging-only; versions = saved snapshots).
- [x] P1 — Server: `viewSnapshot` intent + `snapshotClientMap` resolver. Read-only
      intents are exempt from the edition-locked gate (a locked year is exactly
      when you want to look back).
- [x] P2 — Client: `viewing` state, version resolution (`openVersion`), the
      read-only render path, and the banner over the map.
- [x] P3 — `VersionsPanel` for everyone; officer write verbs (save / restore /
      delete) folded in behind `canManage`.
- [x] P4 — Diff engine (`diffMaps`) + panel list + SVG overlay layer.
- [x] P5 — Typecheck / lint / unit tests / build green; `e2e/map-versions.ts`
      passes 23/23 against a real dev server; committed.

## Findings / gotchas

- `serializeMap` stores **all** edition objects, including unplaced ones; the
  editor only draws `placed || staged`. A snapshot resolver that forgets the
  filter will draw the officer's to-site queue on top of the map at whatever
  stale coordinates those rows carry.
- Snapshot blobs carry `ownerMembershipId` but no `ownerName` (no join at
  serialize time), so names have to be re-resolved at view time or every object
  renders ownerless.
- `map_object.pending*` columns are dead (retired by `plans/multi-suggestions.md`)
  but still present in blobs. Resolve them for shape compatibility; don't build
  on them.
- Restoring or undoing deletes and reinserts `map_object`, which CASCADEs
  `map_edit_suggestion`. So a restore wipes outstanding member versions. Known,
  inherited from `plans/multi-suggestions.md`; not addressed here.

## Things not to do

- Don't add a `variant_id` to the map tables. See decision 2.
- Don't let the viewer write. Every version except official is read-only, and
  the only path from a version to the official map is the officer's existing
  Restore (snapshots) or Approve (suggestions).
- Don't use `title=` attributes for any of the new UI (global rule) — and strip
  them from the snapshot UI being rewritten.

## Progress log

- 2026-08-21: Explored; fork settled with the user; plan written.
- 2026-08-22: Built and verified. One file (`app/routes/dashboard/map.tsx`) plus
  a new E2E (`e2e/map-versions.ts`). No schema change, as designed.
  - Verified against a throwaway DB copy with an officer and a member account:
    both see the Versions panel; only the officer gets save / restore / delete.
    A version opens read-only (palettes stand down, arrow-nudge moves nothing),
    the diff text matches the fixture, the overlay draws, and closing returns
    the official map byte-identical to how it started.
  - Both documented gotchas confirmed handled: an unplaced object in the blob
    does NOT appear in the rendered version, and owner names come back resolved.
  - The 2 hydration warnings the E2E reports are pre-existing — the untouched
    `e2e/noc-uplink.ts` reports the same two on the same page.

## Follow-ups (not done)

- The diff covers objects fully and zones/cables/roads only as net counts. If
  someone starts saving versions that differ by fire lanes, that wants the same
  keyed treatment objects get.
- Restoring or undoing still CASCADE-deletes `map_edit_suggestion`, so an
  officer restore silently wipes every camper's version. Inherited from
  `plans/multi-suggestions.md`; more visible now that those are a named thing
  people look at.
- There is no way to view two non-official versions against *each other* — every
  diff is against the official map.
