# Map undo / redo + snapshots

> Living plan. Plan path: `plans/map-undo-snapshots.md`
> Parent: `plans/camptool.md` ("tagged snapshots within one year" open item).

## Goal

Give the camp map **undo/redo** and (optionally) **named snapshots** (restore
points), so an officer can back out a bad edit and save/restore known-good
layouts.

## Current model (grounds the design)

- All map edits go through one React `fetcher` → the `map.tsx` **action**, keyed
  by ~25 `intent`s (addObject, updateObject(s), deleteObject, placeObject,
  unplace, link/unlink, duplicate, addZone/updateZone/deleteZone, cables, roads,
  savePlacement, addBlock, approve/rejectChange, …). The server persists to
  SQLite and returns authoritative rows; the client reconciles into local state
  (`objects`/`zones`/`cables`/`roads`).
- Per-edition state = `placement` (lot) + `map_object` (+occupants) + `map_zone`
  + `map_cable` + `map_road`, all scoped to `edition_id`.
- There is already a **pending-approval** flow for member (non-officer) edits.

## Design options

**A — Client-session undo (quick).** Keep an in-memory stack of local-state
snapshots; Ctrl+Z restores the previous and re-submits the delta. No schema.
Cons: lost on reload; single-user; racy with the server as source of truth;
re-submitting a whole reverted state needs a bulk "restore" action anyway.

**B — Server snapshot-based undo/redo + snapshots (robust; recommended).** One
new edition-scoped table `map_snapshot(id, camp_id, edition_id, kind:
auto|named, label, data JSON, created_by, seq, created_at)`. The map's full state
serializes to a small JSON blob (dozens of objects → a few KB).
- Every mutating action first captures the pre-edit state as an `auto` snapshot
  (ring-buffered, e.g. keep last ~50) → per-action undo granularity.
- Undo/redo = move a per-edition cursor over the auto snapshots and **restore**
  (replace all edition rows from the JSON in one transaction).
- Named snapshots = same table, `kind=named`, never auto-pruned; "Save
  snapshot" + "Restore" UI.
- Pros: survives reload, multi-user aware, and *is* the snapshots feature.
- Cons: restore is a full-state replace (coarse but correct); multi-user undo
  reverts to a whole prior state (note the semantics; acceptable given usually
  one officer edits at a time).

## Locked decisions (2026-07-03)

1. **Server snapshot model (option B).** New `map_snapshot` table.
2. **Named snapshots now**, bundled with undo/redo.
3. **Two scopes:**
   - **Officers own the official map** — only they change it (manual edit,
     undo/redo, or snapshot restore). Undo/redo + named snapshots act on the
     committed official state.
   - **Members only *suggest*** (the existing pending-approval flow); they get an
     **undo of their own suggestion** (revert their pending item(s) to
     `pendingPrev`). Members never touch the official undo history.

## Design (locked)

- `map_snapshot(id, camp_id, edition_id, kind: auto|named, label, data(JSON),
  created_by_membership_id, seq, created_at)`. `campEdition.mapUndoCursor`
  (int, nullable) points at the seq of the current official state.
- `data` = full edition map state: `placement` + `map_object` (all cols, incl.
  pending fields) + `map_object_occupant` + `map_zone` + `map_cable` + `map_road`.
  Small (KB) — dozens of rows.
- **After-state history with a baseline** (keeps the invariant *DB == snapshot at
  cursor*):
  - First officer edit on an edition with no history: insert baseline `seq 0` =
    pre-edit state, apply edit, insert `seq 1` = post state, cursor = 1.
  - Later officer edit: apply, discard redo branch (auto snaps with seq >
    cursor), insert post state at `cursor+1`, cursor = cursor+1.
  - Undo: cursor−1, restore snapshot(cursor). Redo: cursor+1, restore.
  - Restore a **named** snapshot = treated as a new official edit (goes onto the
    undo history).
  - Ring-buffer: keep the newest ~50 `auto` snaps; `named` never auto-pruned.
- **Restore** = one transaction: delete all edition map rows, reinsert from JSON
  (objects before occupants for the FK). IDs preserved.
- Officer auto-snapshot is a choke point invoked by the officer mutating intents
  only (member suggestion edits do NOT create official undo points; they're
  captured in the next officer snapshot).
- **Member suggestion undo**: revert the caller's own currently-pending item(s)
  to `pendingPrev` (reuses reject logic, member-scoped to own items).

## Plan / phases

**Phase 1 — Official undo/redo + named snapshots (officers). LANDED (code).**
- [x] Schema + migration 0040 (`map_snapshot`, `camp_edition.map_undo_cursor`)
- [x] `serializeMap` / `restoreMap` (delete+reinsert, IDs preserved) helpers
- [x] `recordOfficialHistory` choke point (`officialPre` captured pre-dispatch,
      recorded after) + cursor/prune (ring-buffer 60) logic
- [x] Actions: `undo`, `redo`, `saveSnapshot`, `restoreSnapshot`, `deleteSnapshot`
      (all officer-only; wrapped `runIntent`/`dispatchMutation` in the action)
- [x] Loader returns `history` {canUndo,canRedo} + `snapshots` list;
      `loadClientMap` returns bulk state for undo/redo/restore responses
- [x] Client: `lot`/`history`/`snapshots` lifted to state; reconcile handles
      `d.map`/`d.history`/`d.snapshots`; optimistic canUndo after edits
- [x] Toolbar Undo/Redo (Button.Group) + Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y;
      `SnapshotsPanel` (save/restore/delete) in the rail
- [x] Verified live (commit e8d0cfc, deploy green): save snapshot → appears;
      officer edit (arrow-nudge) → Undo enabled and PERSISTS across reload
      (server checkpoint); Undo → reverts, Redo enables, map intact (34 labels,
      Kitchen back); delete snapshot → removed. Test edit reverted + test
      snapshot cleaned up.

**Phase 2 — Member suggestion undo. LANDED (code).**
- [x] `undoSuggestion` intent (NOT officer-only) reverts the caller's OWN pending
      item(s) to `pendingPrev` — optional `id` targets one, else all their
      pending. Mirrors `rejectChange` but member-scoped to own items. Returns the
      full client map. Not an official checkpoint (officers' history is separate).
- [x] Client: `myPendingCount`; header "Undo my change(s)" button (members only,
      shown when they have pending); Ctrl+Z for members → `doUndoSuggestion`
      (officers' Ctrl+Z still drives official undo).
- [ ] Verify live (needs a member account — officer flow re-checked; member UI
      not browser-tested this session).

## Findings / gotchas
- Another thread owns migration 0039 + `db/schema/flag.ts` + the `index.ts`
  export — DON'T commit those. My schema (mapSnapshot in map.ts, mapUndoCursor in
  camp.ts) is exported via the existing `export * from "./map"` barrel, so no
  index.ts change is needed.
- `restoreMap` is delete-then-reinsert without an explicit txn (matches the
  codebase style; bun-sqlite, small data, officer-triggered). Low risk; note if
  atomicity ever matters.
- Auto-snapshot fires only for OFFICER official-map intents (gated on
  `canManage`); a member's own-item suggestion (updateObject) does NOT create an
  official checkpoint.

## Progress log
- 2026-07-03: Phase 1 built (schema→actions→UI), typecheck/build/lint green.
  Pending live verification.
