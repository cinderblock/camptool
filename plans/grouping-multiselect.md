# Grouping & multi-select (map editor)

> Plan path: `plans/grouping-multiselect.md`
> Requested 2026-06-30. Two locked decisions: **persisted groups**, **multi-select
> first (PR1) then linking (PR2)**.

## Goal

Move/rotate several map objects together. Two pieces:
1. **Multi-select** (transient): shift-click + marquee box-select; drag/rotate the
   whole selection as a block. (PR1)
2. **Linked groups** (persisted): "stick" items into a reusable block via a shared
   group id on `map_object`; selecting any member grabs the whole block; unlink
   breaks it. (PR2)

## PR1 — multi-select (DONE, code complete; not yet deployed/browser-tested)

All in `app/routes/dashboard/map.tsx` (no schema):
- `selectedIds: string[]` alongside the primary `selectedId` (drives the side
  panel). Threaded into `Editor`; `MapObjectShape.selected` = membership; a new
  `soleSelected` shows per-object resize/rotate handles only when exactly one is
  selected (a multi-selection shows ONE group rotate handle on its bounding box).
- **Select:** plain click = just that object; **Shift-click** toggles membership;
  **marquee** (drag empty canvas) box-selects by object center (Shift = additive).
  Plain empty click clears.
- **Group move:** dragging any selected object translates the whole group
  (`groupDrag` ref + `liveGroup`). **Group rotate:** the group handle rotates all
  about the selection centroid. Keyboard: arrows nudge / Space|R rotate / Del
  unplaces the whole selection; Esc clears.
- **Batched persistence:** `updateObjects` + `unplaceObjects` actions (officer-only)
  apply a whole group in ONE request — the single `useFetcher` would otherwise
  cancel rapid per-object submits. Group transforms are officer-gated; a lone item
  still follows the member-own edit rule.

**Gotcha (shared tree):** `app/lib/sun.ts` has another thread's UNCOMMITTED change
(`minuteForAzimuth` 2-arg vs master's 4-arg). It makes local `tsc` show ONE error
on the existing call site (map.tsx ~5384) — NOT our code. Master is 4-arg and our
call is 4-arg, so our commit is consistent; do NOT stage sun.ts or change that call.

## PR2 — linked groups (DONE, code complete; not yet deployed/browser-tested)

- `map_object.group_id` (nullable text), migration 0036. Added to `ObjRow`/`objCols`/
  `toObjRow` + the addObject/addBlock returns.
- **Link/Unlink:** the multi-select banner gets "🔗 Link as block" (sets a fresh
  client-generated uuid on the selection) and "Unlink" (clears it). Officer-only,
  batched via `linkObjects`/`unlinkObjects` actions (client supplies the uuid so the
  optimistic update matches).
- **Atomic blocks:** `expandGroups()` expands any selection touching a linked member
  to the whole block — applied on plain click, shift-click (toggles the whole block),
  and marquee — so a block always selects + moves/rotates together.
- **Visual:** a faint dashed purple hull around every linked block at rest (≥2
  members).

Still TODO (optional polish): read-only gate when the edition is locked (link
buttons already officer-gated); a chain badge; unlink from the side panel.
