# Per-camper suggested edits (multiple suggestions per item)

> Living plan. Plan path: `plans/multi-suggestions.md`. Parent: `plans/camptool.md`.

## Goal

Each camper can have their OWN separate suggested edit to an item — not limited
to one pending suggestion per item. Officers review each and approve/reject
individually.

## Current model (one-per-item, must change)

A member drag mutates the `map_object` row itself (the live geometry BECOMES the
suggestion) and sets `pendingByMembershipId` / `pendingAt` / `pendingPrev` (the
geometry to revert to). So the official geometry is lost while pending, and a
second camper's drag just overwrites/bumps the first — only one suggestion.

## New model (locked direction)

- `map_object` always holds the **official** geometry (never mutated by member
  suggestions).
- New table `map_edit_suggestion(id, camp_id, edition_id, object_id,
  membership_id, x, y, width, height, rotation, created_at, updated_at)`, UNIQUE
  (object_id, membership_id) — one row per camper per item, many campers per item.
- Member drag → upsert THEIR suggestion row (official untouched).
- Officer approve(suggestion) → set the object's official geometry to it, delete
  that suggestion (and optionally the item's others). Reject → delete it.
- Member "undo" → delete their own suggestion(s).
- The old `map_object.pending*` columns get retired (stop writing; leave columns
  for now, drop later).

## Resolved (user)

- Display = **A, ghost overlays** (official for everyone; each suggestion a ghost).
- Approve default keeps the other campers' suggestions.
- Officer approval buttons (user follow-ups):
  - **Approve** (apply → official, keep the other suggestions).
  - **Approve & clear others** (apply, then remove the rest on that item) — the
    "decide to clear or keep" choice at approve time.
  - **Reject** (delete just that suggestion).
  - Standalone **Clear other suggestions** button, available when the officer has
    the main (official) item selected — removes the outstanding suggestions.

## Server intents

- `suggestEdit {objectId, x,y,width,height,rotation}` — member upsert of THEIR row.
- `deleteMySuggestion {objectId}` — member removes their own.
- `approveSuggestion {id, clearOthers?}` — copy geometry → object; delete this
  suggestion; if clearOthers, delete all suggestions on that object.
- `rejectSuggestion {id}` — delete this suggestion.
- `clearSuggestions {objectId}` — delete all suggestions on the object.

## (superseded) The display fork

How should multiple suggestions appear on the map?

- **A — Ghost overlays (recommended).** The map shows the OFFICIAL item for
  everyone; each suggestion draws as a translucent "ghost" footprint at its
  proposed spot, labeled by camper. A member dragging an item moves *their* ghost
  (official stays). Officer approves a ghost → it becomes official.
- **B — Per-viewer live.** Each camper sees the map with *their own* suggestion
  applied as if live; officers see official + a review list. (Different geometry
  per viewer — more complex, more surprising.)

## Phases (after the fork is settled)

- P1 schema + migration (`map_edit_suggestion`).
- P2 suggestion CRUD (member upsert on drag; member delete/undo; officer
  approve/reject) + retire the `pending*` writes.
- P3 rendering (ghosts) + the officer review panel listing per-item suggestions.
- P4 verify live (multi-camper).

## Progress log
- P1+P2 (5af6d16): `map_edit_suggestion` (migration 0048) + server CRUD + loader.
- P3 (client): suggestions state + reconcile (`d.suggestions`); member drag →
  `suggestEdit` (item reverts to official on drop, ghost stays); ghost layer
  (footprint at proposed geometry + suggester name); `SuggestionsPanel` (rail,
  grouped by item: Approve / ✓✕ approve+clear / Reject + per-item Clear all);
  SidePanel per-item review incl. "Approve + clear rest" + "Clear all"; member
  "Undo my suggestion(s)" → `deleteMySuggestion`; retired the old pending path
  (updateObject member branch → 403; panel geometry officer-only).

## Known follow-ups / gotchas
- Undo/redo/snapshot-restore delete+reinsert map_object, which CASCADE-deletes
  suggestions (FK). So an official undo wipes outstanding suggestions. Acceptable
  for now (they'd be stale vs the new official geometry); revisit if annoying.
- The old `map_object.pending*` columns + `approveChange`/`rejectChange`/
  `undoSuggestion` intents are now dead — leave for now, drop later.
- Member suggestions are drag-only (panel numeric fields officer-only).
