# Zones participate in grouping (multi-select, linked blocks, rotate)

> Living plan. Plan path: `plans/zone-grouping.md`. Parent: `plans/camptool.md`.

## Goal

Make zones first-class in the map's grouping, matching objects (user picked ALL
three): (1) **multi-select move** (shift-click / marquee → move/rotate together),
(2) **linked blocks** (persistent `group_id` so moving any member drags the zone),
(3) **rotate with group** (rotate the zone polygon's points about the centroid).

## Current model (objects-only)

- Selection: `selectedId` (single obj, side panel), `selectedIds` (multi obj),
  `selectedZoneId`/`selectedCableId`/`selectedRoadId` (single each). Multi-select
  is objects-only.
- `groupDrag` ref `{mode:move|rotate, startFx, startFy, cx, cy, items:[{id,x,y,
  rotation}]}`; `liveGroup` = moved object states; `commitGroup` → `updateObjects`
  batch (one request).
- `groupCentroid(objs)` = mean of object centers.
- move: translate x/y by (cur−start). rotate: rotate each center about centroid,
  add deg to rotation.
- Marquee (`endMarquee`) box-tests object centers → `expandGroups` → selectedIds.
- `expandGroups(ids)`: adds all objects sharing any touched `groupId`.
- Shift-click (`startDrag` shift branch): toggles obj (+its block) in selectedIds.
- Linked blocks: `linkObjects`/`unlinkObjects` set/clear `map_object.group_id`;
  client sends a client-generated groupId.
- Zone geometry = `points: {x,y}[]` (plot-local feet); `updateZone` persists points.

## Design

Add a **parallel zone multi-selection** rather than refactor `selectedIds`:
- New state `selectedZoneIds: string[]` (CampMap → Editor). The working
  multi-selection is `selectedIds ∪ selectedZoneIds`.
- `groupDrag`/`liveGroup` gain a zone side: `zoneItems:[{id, points}]` (originals)
  and live `zones:[{id, points}]`.
- `groupCentroid` includes zone centroids (mean of a zone's points).
- **move**: translate each zone point by (dx,dy). **rotate**: rotate each zone
  point about the centroid (same cos/sin as objects).
- **commit**: one request must cover objects AND zones → new server intent
  `updateGroup {objects:[…], zones:[{id,points}]}` (or extend `updateObjects`).
- Marquee: also box-test zones (a zone is boxed if its centroid is inside).
- Shift-click a zone toggles it (+ its linked block) into `selectedZoneIds`.
- Group handle (rotate): show when total selected (objs+zones) ≥ 2; centroid over
  both.
- `expandGroups` must span objects+zones sharing a `group_id`.
- Linked blocks: `linkObjects`/`unlinkObjects` accept zone ids too and set/clear
  `map_zone.group_id`. Schema: add `group_id` to `map_zone` (migration).
- Rendering: zones in `selectedZoneIds` render selected (thicker stroke); the
  multi-select side panel counts objs+zones.

## Phases

**P1 — schema.** `map_zone.group_id` (nullable) + migration. Loader/serialize/
restore already `select().from(mapZone)` full rows, so JSON carries it; ZoneRow +
objSelect-equiv need `groupId`.

**P2 — multi-select move/rotate incl. zones.** `selectedZoneIds`, group math for
points, `updateGroup` intent, marquee + shift-click + group-handle + rendering.

**P3 — linked blocks incl. zones.** `expandGroups` spans both; link/unlink accept
zone ids → `map_zone.group_id`; the "Link" action groups a mixed selection.

## Progress log
- P1 — `map_zone.group_id` (migration 0047, hand-trimmed to exclude another
  thread's member_flag) + ZoneRow plumbing. Committed b559949, deploy green.
- P2 — multi-select (shift-click/marquee) + group move/rotate incl. zones;
  `updateObjects` carries a `zones` payload; group box/handle/count span both.
  Committed 6b7fffc, deploy green. Verified: object+zone → "2 items selected" +
  group box renders.
- P3 — linked blocks incl. zones: `expandBlock(objIds,znIds)` spans both;
  link/unlink accept `zoneIds` → `map_zone.group_id`; startDrag/startZoneMove/
  marquee/shift-click pull in the whole block; removed dead `expandGroups`.

## Known follow-ups (not done)
- Keyboard group ops (arrows nudge, R/Space rotate, Del) still act on objects
  only — a mixed group won't nudge/rotate/delete its zones via keyboard (the drag
  handle covers move+rotate). Add if wanted.
