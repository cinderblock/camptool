/**
 * How a camp structure is DRAWN — the single renderer for a placed map object,
 * lifted out of `routes/dashboard/map.tsx` so the full editor and any read-only
 * view (the roster's mini-map) draw from the same source. Add a structure kind
 * here and it looks right everywhere, instead of right in one place and like a
 * grey box in the other.
 *
 * This module is presentation only: `MapObjectShape` closes over no editor
 * state. Passing `editable`/`resizable`/`rotateArmed` false with no-op handlers
 * yields a read-only draw.
 *
 * IMPORTANT: the hypar and hexayurt roofs are filled with `url(#hypar-roof)` /
 * `url(#hexayurt-roof)`. Any <svg> that renders a MapObjectShape MUST also
 * render <MapShapeDefs /> inside its <defs>, or those roofs come out flat and
 * unshaded. The ids are document-global, so don't put two of these SVGs on one
 * page without making them unique first.
 */
import { memo } from "react";
import { clamp } from "~/lib/num";
import {
  type StructureConfig,
  hasTag,
  hexPoints,
  hexVertices,
  kindDef,
} from "~/lib/structures";

/** Last-approved geometry an officer can revert a pending change back to. */
export type PendingPrev = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

export type ObjRow = {
  id: string;
  name: string | null;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  // Above-ground height (ft) for the shade sim; 0 = use the kind default.
  tallFt: number;
  // Draw this object's door on the map (kinds that have one).
  showDoor: boolean;
  // Mirror (left-right reflect) the structure — for chiral kinds.
  mirrored: boolean;
  // Per-object adjustable structure settings (keyed by a CampStructure `controls`
  // entry, e.g. the pyramid's flying-buttress extension). Missing keys fall back
  // to each control's default.
  config: StructureConfig;
  color: string | null;
  notes: string | null;
  // Linked-block id: objects sharing this are moved/rotated together. NULL = not
  // linked.
  groupId: string | null;
  // Parked in the staging apron outside the lot border rather than sited in it.
  // Still "not placed" as far as the officer queue is concerned — see the column
  // comment in db/schema/map.ts.
  staged: boolean;
  // The camper who brought this (NULL = shared/communal camp item).
  ownerMembershipId: string | null;
  ownerName: string | null;
  // Placement WISHES, surfaced as faint lines on the map and never enforced:
  // "next to my vehicle", and "next to this person's stuff".
  placeNearVehicle: boolean;
  nearMembershipId: string | null;
  // Set when there's an unapproved move/resize/rotate suggestion (the live
  // geometry is the proposed state; `prev` is what Reject restores). `by` is the
  // membership that proposed it — ANY camper may suggest an edit to ANY item, so
  // the proposer isn't necessarily the owner.
  pending: { prev: PendingPrev; by: string | null } | null;
};

/** Door symbol: opening gap + leaf + swing arc, centered on an edge. Swings
 * OUT (away from the interior). (mx,my) = edge midpoint; (ex,ey) = unit along
 * the edge; (nx,ny) = inward normal; len = door width in px. Drawn in local
 * coords so it rotates with the object. */
// Door linework color — theme-aware (near-black in light mode, near-white in
// dark mode) so doors stay visible on the dark-mode ground.
const DOOR_STROKE = "var(--mantine-color-text)";

function Door({
  mx,
  my,
  ex,
  ey,
  nx,
  ny,
  len,
}: {
  mx: number;
  my: number;
  ex: number;
  ey: number;
  nx: number;
  ny: number;
  len: number;
}) {
  const hx = mx - (ex * len) / 2;
  const hy = my - (ey * len) / 2;
  const lx = mx + (ex * len) / 2;
  const ly = my + (ey * len) / 2;
  // Open 180° outward: the leaf lies flat against the exterior wall, extending
  // from the hinge away from the opening; the swing arc is the outward semicircle.
  const ox = -nx;
  const oy = -ny;
  const off = 1.5;
  const tipx = hx - ex * len;
  const tipy = hy - ey * len;
  const sweep = ey * nx - ex * ny > 0 ? 1 : 0;
  return (
    <g pointerEvents="none">
      <line x1={hx} y1={hy} x2={lx} y2={ly} stroke="#fff" strokeWidth={2.5} />
      <line
        x1={hx + ox * off}
        y1={hy + oy * off}
        x2={tipx + ox * off}
        y2={tipy + oy * off}
        stroke={DOOR_STROKE}
        strokeWidth={1}
      />
      <path
        d={`M ${lx} ${ly} A ${len} ${len} 0 1 ${sweep} ${tipx} ${tipy}`}
        stroke={DOOR_STROKE}
        strokeWidth={0.75}
        strokeOpacity={0.5}
        fill="none"
      />
    </g>
  );
}

/** Shift (px) for a movable door along its wall: `offset` is a fraction of the
 * wall (−0.5…0.5, from the panel's "Door position" control), clamped so the door
 * (length `len`) stays fully on the wall (length `wall`). */
function doorShift(offset: number, len: number, wall: number): number {
  const maxFrac = Math.max(0, 0.5 - len / (2 * wall));
  return clamp(offset, -maxFrac, maxFrac) * wall;
}

/** Hyparhut door: an opening on the RIGHT of the front (+y) edge (right jamb by
 * the 6' corner) that swings OUT — the closed leaf along the edge plus an
 * outward (away from the hut) semicircle clearance, below the front edge.
 * Matches the camp drawing. px,py,w,h are the body's local pixel rect. */
function HyparDoor({
  px,
  py,
  w,
  h,
}: {
  px: number;
  py: number;
  w: number;
  h: number;
}) {
  // Hut is a fixed 8' square, so width fractions are exact feet.
  const doorW = w * (2.5 / 8); // 30" opening
  const right = px + w * (7.5 / 8); // right jamb 6" from the corner
  const left = right - doorW;
  const y = py + h; // front edge
  const r = doorW / 2; // semicircle clearance: chord = opening = diameter
  return (
    <g pointerEvents="none">
      <line x1={left} y1={y} x2={right} y2={y} stroke="#fff" strokeWidth={2} />
      {/* Sweep 0 bulges the arc outward — below the front edge, away from the hut. */}
      <path
        d={`M ${left} ${y} A ${r} ${r} 0 0 0 ${right} ${y}`}
        stroke={DOOR_STROKE}
        strokeOpacity={0.5}
        strokeWidth={0.75}
        fill="none"
      />
    </g>
  );
}

/** Container cargo doors: two leaves on the short (+y) end, each half the 8' end,
 * that swing OUT and fold 270° back flat against the side walls. px,py,w,h are
 * the body's local pixel rect (doors on the bottom end). */
function ContainerDoors({
  px,
  py,
  w,
  h,
}: {
  px: number;
  py: number;
  w: number;
  h: number;
}) {
  const L = w / 2; // each leaf spans half the 8' door end
  const yb = py + h; // door end
  return (
    <g pointerEvents="none">
      {/* Open leaves folded back along the side walls. */}
      <line
        x1={px}
        y1={yb}
        x2={px}
        y2={yb - L}
        stroke={DOOR_STROKE}
        strokeOpacity={0.6}
        strokeWidth={1.5}
      />
      <line
        x1={px + w}
        y1={yb}
        x2={px + w}
        y2={yb - L}
        stroke={DOOR_STROKE}
        strokeOpacity={0.6}
        strokeWidth={1.5}
      />
      {/* 270° swing arcs (large-arc): out, around, and back to the side wall. */}
      <path
        d={`M ${px + L} ${yb} A ${L} ${L} 0 1 1 ${px} ${yb - L}`}
        stroke={DOOR_STROKE}
        strokeOpacity={0.4}
        strokeWidth={0.75}
        fill="none"
      />
      <path
        d={`M ${px + w - L} ${yb} A ${L} ${L} 0 1 0 ${px + w} ${yb - L}`}
        stroke={DOOR_STROKE}
        strokeOpacity={0.4}
        strokeWidth={0.75}
        fill="none"
      />
    </g>
  );
}

/** Schematic top-down detailing drawn over a vehicle/tent footprint so kinds
 * read at a glance (front = top edge). Local coords — rotates with the object —
 * and never intercepts pointer events so the body underneath stays draggable. */
function KindGlyph({
  kind,
  px,
  py,
  w,
  h,
}: {
  kind: string;
  px: number;
  py: number;
  w: number;
  h: number;
}) {
  const dark = "#1c1c1c";
  const glass = "#cfe0ff";
  const X = (f: number) => px + w * f;
  const Y = (f: number) => py + h * f;
  const line = { stroke: dark, strokeOpacity: 0.55, fill: "none" } as const;
  const pane = { fill: glass, fillOpacity: 0.55, stroke: "none" } as const;

  // Two wheels (flush to each side) at each given length-fraction.
  const wheels = (fracs: number[]) => {
    const ww = Math.max(2, w * 0.12);
    const wl = Math.max(3, h * 0.1);
    return fracs.flatMap((f) =>
      [px, px + w - ww].map((wx) => (
        <rect
          key={`w${f}-${wx}`}
          x={wx}
          y={py + h * f - wl / 2}
          width={ww}
          height={wl}
          rx={Math.min(ww, wl) * 0.35}
          fill={dark}
          fillOpacity={0.6}
        />
      )),
    );
  };

  if (kind === "tent") {
    if (Math.min(w, h) < 8) return null;
    return (
      <g pointerEvents="none" stroke={dark} strokeOpacity={0.4} fill="none">
        <line x1={px} y1={py} x2={px + w} y2={py + h} />
        <line x1={px + w} y1={py} x2={px} y2={py + h} />
        <circle
          cx={px + w / 2}
          cy={py + h / 2}
          r={Math.min(w, h) * 0.08}
          fill={dark}
          fillOpacity={0.3}
          stroke="none"
        />
      </g>
    );
  }

  // Vehicles get cluttered when tiny; skip detailing below a threshold.
  if (w < 10 || h < 16) return null;

  if (kind === "car") {
    return (
      <g pointerEvents="none">
        {wheels([0.16, 0.8])}
        <polygon
          points={`${X(0.38)},${Y(0.16)} ${X(0.62)},${Y(0.16)} ${X(0.72)},${Y(0.3)} ${X(0.28)},${Y(0.3)}`}
          {...pane}
        />
        <rect
          x={X(0.2)}
          y={Y(0.3)}
          width={w * 0.6}
          height={h * 0.42}
          rx={Math.min(w, h) * 0.12}
          {...line}
        />
        <polygon
          points={`${X(0.3)},${Y(0.72)} ${X(0.7)},${Y(0.72)} ${X(0.6)},${Y(0.85)} ${X(0.4)},${Y(0.85)}`}
          {...pane}
          fillOpacity={0.4}
        />
      </g>
    );
  }

  if (kind === "truck" || kind === "box-truck") {
    // Cab + cargo box — reads right for a pickup and a box-truck conversion.
    return (
      <g pointerEvents="none">
        {wheels([0.18, 0.82])}
        <rect
          x={X(0.14)}
          y={Y(0.07)}
          width={w * 0.72}
          height={h * 0.27}
          rx={Math.min(w, h) * 0.08}
          {...line}
        />
        <line x1={X(0.2)} y1={Y(0.15)} x2={X(0.8)} y2={Y(0.15)} {...line} />
        <rect
          x={X(0.1)}
          y={Y(0.4)}
          width={w * 0.8}
          height={h * 0.52}
          rx={2}
          {...line}
        />
      </g>
    );
  }

  if (kind === "van") {
    return (
      <g pointerEvents="none">
        {wheels([0.16, 0.84])}
        <polygon
          points={`${X(0.26)},${Y(0.07)} ${X(0.74)},${Y(0.07)} ${X(0.84)},${Y(0.22)} ${X(0.16)},${Y(0.22)}`}
          {...pane}
        />
        <line x1={X(0.08)} y1={Y(0.28)} x2={X(0.92)} y2={Y(0.28)} {...line} />
        <line x1={X(0.62)} y1={Y(0.36)} x2={X(0.62)} y2={Y(0.74)} {...line} />
      </g>
    );
  }

  if (kind === "rv") {
    return (
      <g pointerEvents="none">
        {wheels([0.12, 0.72])}
        <polygon
          points={`${X(0.22)},${Y(0.02)} ${X(0.78)},${Y(0.02)} ${X(0.88)},${Y(0.13)} ${X(0.12)},${Y(0.13)}`}
          {...pane}
          fillOpacity={0.5}
        />
        <line x1={X(0.06)} y1={Y(0.16)} x2={X(0.94)} y2={Y(0.16)} {...line} />
        {[0.28, 0.42, 0.56].map((f) => (
          <rect
            key={f}
            x={X(0.04)}
            y={Y(f)}
            width={w * 0.06}
            height={h * 0.08}
            rx={1}
            {...pane}
            fillOpacity={0.5}
          />
        ))}
      </g>
    );
  }

  if (kind === "skoolie") {
    // Bus: windshield up front + rows of side window panes.
    return (
      <g pointerEvents="none">
        {wheels([0.14, 0.78])}
        <polygon
          points={`${X(0.24)},${Y(0.03)} ${X(0.76)},${Y(0.03)} ${X(0.86)},${Y(0.1)} ${X(0.14)},${Y(0.1)}`}
          {...pane}
        />
        {[0.18, 0.32, 0.46, 0.6, 0.74].flatMap((f) =>
          [X(0.05), X(0.83)].map((wx) => (
            <rect
              key={`${f}-${wx}`}
              x={wx}
              y={Y(f)}
              width={w * 0.12}
              height={h * 0.06}
              rx={1}
              {...pane}
              fillOpacity={0.5}
            />
          )),
        )}
      </g>
    );
  }

  // Towed trailers (no cab): axles + a hitch tongue at the front (-y).
  if (
    kind === "airstream" ||
    kind === "toy-hauler" ||
    kind === "teardrop" ||
    kind === "popup-camper"
  ) {
    const tandem = kind === "airstream" || kind === "toy-hauler";
    return (
      <g pointerEvents="none">
        {wheels(tandem ? [0.6, 0.74] : [0.62])}
        <polygon
          points={`${X(0.42)},${py} ${X(0.58)},${py} ${X(0.5)},${py - h * 0.05}`}
          {...line}
          fill={dark}
          fillOpacity={0.3}
        />
        {kind === "airstream" ? (
          // Ribbed rounded shell hint.
          [0.2, 0.34, 0.48, 0.62].map((f) => (
            <line
              key={f}
              x1={X(0.1)}
              y1={Y(f)}
              x2={X(0.9)}
              y2={Y(f)}
              {...line}
            />
          ))
        ) : kind === "toy-hauler" ? (
          // Toy hauler: garage line near the rear.
          <line x1={X(0.1)} y1={Y(0.5)} x2={X(0.9)} y2={Y(0.5)} {...line} />
        ) : null}
      </g>
    );
  }

  return null;
}

/** The footprint outline (object-local feet, centered on the object) for a KIND
 * at a given size — the real shape, so a hexayurt throws a hexagonal shadow (and
 * a triangle is tested as a triangle), not a box. */
export function footprintOutline(
  kind: string,
  w: number,
  h: number,
  config: StructureConfig = {},
  mirror = false,
): Array<[number, number]> {
  const def = kindDef(kind);
  // A camp-theme structure can declare its true outline (e.g. the pyramid's
  // base triangle + buttress reach); use it instead of the bounding box. A
  // chiral structure's outline is reflected (x→−x) when the object is mirrored,
  // so the asymmetric part (the flying buttress) is bounded on the correct side.
  if (def.footprint) {
    return def
      .footprint(w, h, config)
      .map((p) => [mirror ? -p.x : p.x, p.y] as [number, number]);
  }
  if (def.shape === "hexagon") {
    return hexVertices(0, 0, w, h).map(
      (p) => [p.x - w / 2, p.y - h / 2] as [number, number],
    );
  }
  if (def.shape === "dome") {
    // Circle (ellipse if non-uniform) approximated as a 16-gon, so the dome
    // casts a round/elongated shadow rather than a box.
    const rx = w / 2;
    const ry = h / 2;
    const n = 16;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * 2 * Math.PI;
      return [Math.cos(a) * rx, Math.sin(a) * ry] as [number, number];
    });
  }
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
}

/**
 * The outline of a kind's **horizontal slice at height `z`** (object-local feet,
 * centered), or `null` if there's nothing there — the solid has ended.
 *
 * Most structures are prisms: the same outline all the way up to `tallFt`, then
 * nothing. Two aren't, and for a line-of-sight test the difference is the whole
 * answer: a dome is a shrinking circle, and a structure that declares
 * `crossSectionAt` (the Sierpinski pyramid: a tetrahedron, 40′ across at the
 * ground and a point at 32.7′) tapers to whatever shape it likes. Treating
 * either as a box makes it block paths it doesn't really block.
 */
export function crossSectionOutline(
  kind: string,
  w: number,
  h: number,
  config: StructureConfig,
  mirror: boolean,
  z: number,
  tallFt: number,
): Array<[number, number]> | null {
  const def = kindDef(kind);
  if (z <= 0) return footprintOutline(kind, w, h, config, mirror);
  if (def.crossSectionAt) {
    const pts = def.crossSectionAt(z, w, h, config);
    if (!pts || pts.length < 3) return null;
    return pts.map((p) => [mirror ? -p.x : p.x, p.y] as [number, number]);
  }
  if (z > tallFt) return null;
  if (def.shape === "dome") {
    // Half-ellipsoid: the radius at height z falls off as √(1 − (z/tall)²), so
    // the slice near the top is a small circle rather than the full base.
    const s = Math.sqrt(Math.max(0, 1 - (z / (tallFt || 1)) ** 2));
    if (s < 0.02) return null;
    return footprintOutline(kind, w * s, h * s, config, mirror);
  }
  return footprintOutline(kind, w, h, config, mirror);
}

/**
 * The heights (feet) a line-of-sight test has to compare a solid against. A
 * prism is decided entirely by its top edge — one rung. Anything that tapers
 * has to be checked level by level, because both the solid and the sight line
 * are moving: the solid narrows as it rises, and the sight line climbs toward
 * the far antenna, so neither the ground slice nor the top slice alone settles
 * it.
 */
export function crossSectionLevels(kind: string, tallFt: number): number[] {
  const def = kindDef(kind);
  if (!def.crossSectionAt && def.shape !== "dome") return [tallFt];
  const n = 16;
  return Array.from({ length: n }, (_, i) => (tallFt * (i + 1)) / n);
}

/** Gradient defs the shapes above reference by id. Render inside an <svg>'s
 * <defs> alongside any MapObjectShape — see the module header. */
export function MapShapeDefs() {
  return (
    <>
      {/* Hypar roof: bright at the high front-right corner (by the door) →
              dark toward the low back-left, matching the per-corner heights. */}
      <linearGradient id="hypar-roof" x1="1" y1="0.9" x2="0.05" y2="0.25">
        <stop offset="0" stopColor="#ffffff" stopOpacity={0.6} />
        <stop offset="1" stopColor="#000000" stopOpacity={0.38} />
      </linearGradient>
      {/* Hexayurt roof: bright apex at the center → dark at the eaves. */}
      <radialGradient id="hexayurt-roof" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor="#ffffff" stopOpacity={0.62} />
        <stop offset="1" stopColor="#000000" stopOpacity={0.32} />
      </radialGradient>
    </>
  );
}

// Memoized so a drag only re-renders the moved object. setObjects maps
// unchanged objects to the same reference, so their `o` prop stays ===; the
// inline handler props change identity each render but behave identically (they
// close over the same `o`), so the comparator ignores them.
export const MapObjectShape = memo(
  function MapObjectShape({
    o,
    originX,
    originY,
    ppf,
    selected,
    soleSelected,
    editable,
    resizable,
    rotateArmed,
    dim,
    showDoors,
    overflow,
    staged,
    night,
    onBodyDown,
    onResizeDown,
    onRotateDown,
  }: {
    o: ObjRow;
    originX: number;
    originY: number;
    ppf: number;
    selected: boolean;
    /** This is the ONLY selected object (so it shows resize/rotate handles; a
     * multi-selection shows a single group handle instead). */
    soleSelected: boolean;
    editable: boolean;
    /** Whether the corner drag-resize handle is offered (owner-only; see the
     * `resizable` helper). Move/rotate follow `editable` instead. */
    resizable: boolean;
    /** Rotation armed by a second click on the already-selected item — only then
     * is the rotate handle shown. */
    rotateArmed: boolean;
    dim: boolean;
    showDoors: boolean;
    /** The object's footprint crosses the lot border — half in, half out. */
    overflow: boolean;
    /** Parked in the staging apron outside the lot rather than sited in it. Drawn
     * at full size (seeing the real size is the point) but slightly faded, so a
     * glance at the map separates "this is where it goes" from "this is what it
     * is". Defaults to false for read-only views, which never show staged items. */
    staged?: boolean;
    /** The night-lighting sim is active (sun below the horizon). */
    night: boolean;
    onBodyDown: (e: React.PointerEvent) => void;
    onResizeDown: (e: React.PointerEvent) => void;
    onRotateDown: (e: React.PointerEvent) => void;
  }) {
    const def = kindDef(o.kind);
    const px = originX + o.x * ppf;
    const py = originY + o.y * ppf;
    const w = o.width * ppf;
    const h = o.height * ppf;
    const cx = px + w / 2;
    const cy = py + h / 2;
    const fill = o.color ?? def.color;
    // Editable items drag (move cursor); everything else is still selectable for
    // read-only details (pointer cursor).
    const bodyStyle = { cursor: editable ? "move" : "pointer" } as const;
    // A canopy (shade/carport/popup/…) is a translucent overhead drawn over the
    // items beneath it. Its body is click-through (pointer-events none) so clicking
    // a block under it grabs the block; clicking an empty part falls through to the
    // canvas, which hit-tests canopies and selects this one (see onCanvasDown).
    const isShade = def.canopyShade === true;
    // Show the owner's first name on sleeping structures (domiciles), drawn
    // upright outside the rotated group (the center cx,cy is rotation-invariant).
    const isDomicile = hasTag(o.kind, "domicile");
    const ownerFirst = o.ownerName?.split(" ")[0] ?? null;
    const bigEnough = w > 22 && h > 16;
    // A given name (e.g. a named RV) is the prominent label; the owner's first
    // name (domiciles) is shown secondarily beneath it.
    const showName = !!o.name && bigEnough;
    const showOwner = isDomicile && !!ownerFirst && bigEnough;
    // Label orientation: align with the object's dominant (longer) axis — a
    // length-dominant (taller-than-wide) object reads along its length (+90°) —
    // then rotate with the object and fold into (−90°, 90°] so the text is never
    // upside down (readable from the bottom, or the right when vertical).
    let labelAngle = (((o.rotation + (h > w ? 90 : 0)) % 360) + 360) % 360;
    if (labelAngle > 90 && labelAngle <= 270) labelAngle -= 180;
    return (
      <g opacity={dim ? 0.28 : staged ? 0.72 : undefined}>
        <g transform={`rotate(${o.rotation} ${cx} ${cy})`}>
          {isShade ? (
            <rect
              x={px}
              y={py}
              width={w}
              height={h}
              rx={3}
              fill={fill}
              fillOpacity={0.18}
              stroke={selected ? "#1c1c1c" : fill}
              strokeWidth={selected ? 2.5 : 2}
              strokeDasharray="6 4"
              pointerEvents="none"
            />
          ) : def.shape === "rect" ? (
            <>
              {/* RV slide-out pop-outs (drawn under the body, attached to a side). */}
              {o.kind === "rv" && (o.config.popoutL ?? 0) > 0 ? (
                <rect
                  x={px - clamp(o.config.popoutL ?? 0, 0, 4) * ppf}
                  y={py + h * 0.2}
                  width={clamp(o.config.popoutL ?? 0, 0, 4) * ppf}
                  height={h * 0.6}
                  fill={fill}
                  fillOpacity={0.7}
                  stroke={selected ? "#1c1c1c" : fill}
                  strokeWidth={selected ? 2 : 1}
                  style={bodyStyle}
                  onPointerDown={onBodyDown}
                />
              ) : null}
              {o.kind === "rv" && (o.config.popoutR ?? 0) > 0 ? (
                <rect
                  x={px + w}
                  y={py + h * 0.2}
                  width={clamp(o.config.popoutR ?? 0, 0, 4) * ppf}
                  height={h * 0.6}
                  fill={fill}
                  fillOpacity={0.7}
                  stroke={selected ? "#1c1c1c" : fill}
                  strokeWidth={selected ? 2 : 1}
                  style={bodyStyle}
                  onPointerDown={onBodyDown}
                />
              ) : null}
              {/* Toy-hauler fold-down rear ramp (apron off the +y/rear edge), with
              tread slats. Drawn under the body so the body sits over the hinge. */}
              {o.kind === "toy-hauler" && (o.config.ramp ?? 0) > 0
                ? (() => {
                    const rampPx = Math.min(o.width, 8) * ppf;
                    return (
                      <g pointerEvents="none">
                        <rect
                          x={px}
                          y={py + h}
                          width={w}
                          height={rampPx}
                          fill={fill}
                          fillOpacity={0.45}
                          stroke={selected ? "#1c1c1c" : fill}
                          strokeWidth={selected ? 1.5 : 0.75}
                        />
                        {[0.25, 0.5, 0.75].map((f) => (
                          <line
                            key={f}
                            x1={px}
                            y1={py + h + rampPx * f}
                            x2={px + w}
                            y2={py + h + rampPx * f}
                            stroke="#1c1c1c"
                            strokeOpacity={0.3}
                            strokeWidth={0.6}
                          />
                        ))}
                      </g>
                    );
                  })()
                : null}
              {/* Pop-up camper fold-out bunks off both ends when popped up
              (drawn under the body, like the RV pop-outs). */}
              {o.kind === "popup-camper" && (o.config.popped ?? 1) > 0
                ? (() => {
                    const out = 3.5 * ppf;
                    const bw = w * 0.85;
                    const bx = px + (w - bw) / 2;
                    return (
                      <g style={bodyStyle} onPointerDown={onBodyDown}>
                        {[py - out, py + h].map((by) => (
                          <rect
                            key={by}
                            x={bx}
                            y={by}
                            width={bw}
                            height={out}
                            fill={fill}
                            fillOpacity={0.55}
                            stroke={selected ? "#1c1c1c" : fill}
                            strokeWidth={selected ? 1.5 : 0.75}
                          />
                        ))}
                      </g>
                    );
                  })()
                : null}
              <rect
                x={px}
                y={py}
                width={w}
                height={h}
                rx={3}
                fill={fill}
                fillOpacity={0.78}
                stroke={selected ? "#1c1c1c" : fill}
                strokeWidth={selected ? 2 : 1}
                style={bodyStyle}
                onPointerDown={onBodyDown}
              />
              {/* Generator marker (noise/exhaust) at the front end. */}
              {o.kind === "rv" && (o.config.generator ?? 0) > 0
                ? (() => {
                    const s = Math.min(2.6 * ppf, w * 0.55);
                    const gy = py + h * 0.05;
                    return (
                      <g pointerEvents="none">
                        <rect
                          x={cx - s / 2}
                          y={gy}
                          width={s}
                          height={s * 0.72}
                          rx={1}
                          fill="#e03131"
                          stroke="#fff"
                          strokeWidth={0.6}
                        />
                        <text
                          x={cx}
                          y={gy + s * 0.36}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={s * 0.55}
                          fontWeight={700}
                          fill="#fff"
                        >
                          G
                        </text>
                      </g>
                    );
                  })()
                : null}
              {/* Sewer cleanout marker (dump access) at the rear end. */}
              {o.kind === "rv" && (o.config.cleanout ?? 0) > 0
                ? (() => {
                    const r = Math.min(1.3 * ppf, w * 0.22);
                    const ccy = py + h - h * 0.05 - r;
                    return (
                      <g pointerEvents="none">
                        <circle
                          cx={cx}
                          cy={ccy}
                          r={r}
                          fill="#495057"
                          stroke="#fff"
                          strokeWidth={0.6}
                        />
                        <circle cx={cx} cy={ccy} r={r * 0.45} fill="#ced4da" />
                      </g>
                    );
                  })()
                : null}
            </>
          ) : def.shape === "hypar" ? (
            <>
              <rect
                x={px}
                y={py}
                width={w}
                height={h}
                rx={2}
                fill={fill}
                fillOpacity={0.78}
                stroke={selected ? "#1c1c1c" : fill}
                strokeWidth={selected ? 2 : 1}
                style={bodyStyle}
                onPointerDown={onBodyDown}
              />
              {/* Roof shading: high corner light → low corner dark (tilted). */}
              <rect
                x={px}
                y={py}
                width={w}
                height={h}
                rx={2}
                fill="url(#hypar-roof)"
                pointerEvents="none"
              />
              {/* A pair of roof solar panels. */}
              {[0.17, 0.53].map((fy) => (
                <rect
                  key={fy}
                  x={px + w * 0.24}
                  y={py + h * fy}
                  width={w * 0.52}
                  height={h * 0.3}
                  rx={0.5}
                  fill="#4dabf7"
                  fillOpacity={0.55}
                  stroke="#1971c2"
                  strokeWidth={0.7}
                  pointerEvents="none"
                />
              ))}
              {/* Roof fold (hypar ridge) down the middle, over the panels. */}
              <line
                x1={cx}
                y1={py}
                x2={cx}
                y2={py + h}
                stroke="#1c1c1c"
                strokeOpacity={0.45}
                strokeWidth={0.75}
                pointerEvents="none"
              />
              {/* Roof AC unit on the back edge by the high corner — a power
                  connection point cables snap to. */}
              <rect
                x={px + w * 0.58}
                y={py - h * 0.16}
                width={w * 0.22}
                height={h * 0.18}
                rx={0.5}
                fill="#ced4da"
                stroke="#868e96"
                strokeWidth={0.6}
                pointerEvents="none"
              />
            </>
          ) : def.shape === "hexagon" ? (
            <>
              <polygon
                points={hexPoints(px, py, w, h)}
                fill={fill}
                fillOpacity={0.78}
                stroke={selected ? "#1c1c1c" : fill}
                strokeWidth={selected ? 2 : 1}
                style={bodyStyle}
                onPointerDown={onBodyDown}
              />
              {/* Pyramidal roof: bright apex at center → dark eaves. */}
              <polygon
                points={hexPoints(px, py, w, h)}
                fill="url(#hexayurt-roof)"
                pointerEvents="none"
              />
              {/* Ridge lines from each vertex to the center apex. */}
              {hexVertices(px, py, w, h).map((v) => (
                <line
                  key={`${v.x},${v.y}`}
                  x1={cx}
                  y1={cy}
                  x2={v.x}
                  y2={v.y}
                  stroke="#1c1c1c"
                  strokeOpacity={0.35}
                  strokeWidth={0.75}
                  pointerEvents="none"
                />
              ))}
            </>
          ) : def.shape === "dome" ? (
            <>
              <ellipse
                cx={cx}
                cy={cy}
                rx={w / 2}
                ry={h / 2}
                fill={fill}
                fillOpacity={0.78}
                stroke={selected ? "#1c1c1c" : fill}
                strokeWidth={selected ? 2 : 1}
                style={bodyStyle}
                onPointerDown={onBodyDown}
              />
              {/* Geodesic facets: an inner ring + radial struts. */}
              <ellipse
                cx={cx}
                cy={cy}
                rx={w * 0.28}
                ry={h * 0.28}
                fill="none"
                stroke="#1c1c1c"
                strokeOpacity={0.3}
                strokeWidth={0.75}
                pointerEvents="none"
              />
              {[0, 60, 120, 180, 240, 300].map((a) => {
                const r = (a * Math.PI) / 180;
                return (
                  <line
                    key={a}
                    x1={cx}
                    y1={cy}
                    x2={cx + Math.cos(r) * (w / 2)}
                    y2={cy + Math.sin(r) * (h / 2)}
                    stroke="#1c1c1c"
                    strokeOpacity={0.25}
                    strokeWidth={0.6}
                    pointerEvents="none"
                  />
                );
              })}
            </>
          ) : def.shape === "custom" && def.renderFootprint ? (
            // A camp-theme structure draws its own footprint in plot-local FEET
            // (0,0→w,h); the wrapper translates+scales it into pixel space so it
            // composes with drag/resize/rotate like a built-in shape.
            <g
              style={bodyStyle}
              onPointerDown={onBodyDown}
              transform={`translate(${px} ${py}) scale(${ppf})`}
            >
              {def.renderFootprint({
                w: o.width,
                h: o.height,
                color: fill,
                selected,
                rotation: o.rotation,
                mirror: o.mirrored,
                config: o.config,
                night,
              })}
            </g>
          ) : (
            <rect
              x={px}
              y={py}
              width={w}
              height={h}
              rx={3}
              fill={fill}
              fillOpacity={0.78}
              stroke={selected ? "#1c1c1c" : fill}
              strokeWidth={selected ? 2 : 1}
              style={bodyStyle}
              onPointerDown={onBodyDown}
            />
          )}
          <KindGlyph kind={o.kind} px={px} py={py} w={w} h={h} />
          {showDoors && o.showDoor && o.kind === "rv" ? (
            <Door
              mx={px + w}
              my={
                cy +
                doorShift(
                  o.config.doorOffset ?? 0,
                  Math.min(3 * ppf, h * 0.4),
                  h,
                )
              }
              ex={0}
              ey={1}
              nx={-1}
              ny={0}
              len={Math.min(3 * ppf, h * 0.4)}
            />
          ) : showDoors && o.showDoor && o.kind === "hyparhut" ? (
            <HyparDoor px={px} py={py} w={w} h={h} />
          ) : showDoors && o.showDoor && o.kind === "hexayurt" ? (
            <Door
              mx={
                cx +
                doorShift(
                  o.config.doorOffset ?? 0,
                  Math.min(3 * ppf, w * 0.5),
                  w,
                )
              }
              my={py + h}
              ex={1}
              ey={0}
              nx={0}
              ny={-1}
              len={Math.min(3 * ppf, w * 0.5)}
            />
          ) : showDoors && o.showDoor && o.kind === "container" ? (
            <ContainerDoors px={px} py={py} w={w} h={h} />
          ) : null}
          {o.kind === "tent" ? (
            <rect
              x={cx - Math.min(6 * ppf, w * 0.7) / 2}
              y={py + h}
              width={Math.min(6 * ppf, w * 0.7)}
              height={3 * ppf}
              rx={1}
              fill={fill}
              fillOpacity={0.28}
              stroke={fill}
              strokeWidth={1}
              pointerEvents="none"
            />
          ) : null}
          {/* Rooftop tent (opened) on a vehicle's roof — only kinds carrying
          the rooftopTent control ever set this config key. */}
          {(o.config.rooftopTent ?? 0) > 0
            ? (() => {
                const tw = Math.min(4.5 * ppf, w * 0.7);
                const tl = Math.min(7 * ppf, h * 0.55);
                return (
                  <g pointerEvents="none">
                    <rect
                      x={cx - tw / 2}
                      y={cy - tl / 2}
                      width={tw}
                      height={tl}
                      rx={2}
                      fill="#495057"
                      fillOpacity={0.55}
                      stroke="#1c1c1c"
                      strokeOpacity={0.5}
                      strokeWidth={0.8}
                    />
                    <line
                      x1={cx}
                      y1={cy - tl / 2}
                      x2={cx}
                      y2={cy + tl / 2}
                      stroke="#f1f3f5"
                      strokeOpacity={0.8}
                      strokeWidth={0.8}
                    />
                  </g>
                );
              })()
            : null}
          {o.pending ? (
            // Awaiting officer approval: trace the REAL footprint in dashed amber
            // (+ a corner dot) so pending edits stand out on the map.
            <>
              <polygon
                points={footprintOutline(
                  o.kind,
                  o.width,
                  o.height,
                  o.config,
                  o.mirrored,
                )
                  .map(([lx, ly]) => `${cx + lx * ppf},${cy + ly * ppf}`)
                  .join(" ")}
                fill="none"
                stroke="#f08c00"
                strokeWidth={2}
                strokeDasharray="4 3"
                pointerEvents="none"
              />
              <circle
                cx={px + w}
                cy={py}
                r={4}
                fill="#f08c00"
                stroke="#fff"
                strokeWidth={1}
                pointerEvents="none"
              />
            </>
          ) : null}
          {overflow ? (
            // The footprint crosses the lot border — flag it tracing the REAL
            // outline (triangle/hexagon/…), not a bounding box.
            <polygon
              points={footprintOutline(
                o.kind,
                o.width,
                o.height,
                o.config,
                o.mirrored,
              )
                .map(([lx, ly]) => `${cx + lx * ppf},${cy + ly * ppf}`)
                .join(" ")}
              fill="none"
              stroke="#fa5252"
              strokeWidth={2.5}
              strokeDasharray="5 3"
              pointerEvents="none"
            />
          ) : null}
          {soleSelected && editable ? (
            <>
              {/* Rotate handle: only after a second click on the selected item
              (rotateArmed), and never for a kind with no facing — a Wi-Fi AP
              radiates in every direction and the uplink dish is aimed by the
              map, so an angle on either is a control that does nothing. */}
              {rotateArmed && !def.fixedRotation ? (
                <>
                  <line
                    x1={cx}
                    y1={py}
                    x2={cx}
                    y2={py - 22}
                    stroke="#1c1c1c"
                    strokeWidth={1}
                  />
                  <circle
                    cx={cx}
                    cy={py - 22}
                    r={6}
                    fill="#fff"
                    stroke="#1c1c1c"
                    strokeWidth={1.5}
                    style={{ cursor: "grab" }}
                    onPointerDown={onRotateDown}
                  />
                </>
              ) : null}
              {resizable &&
              !(def.vehicle || def.rigid || def.shape === "dome") ? (
                // Domes stay round: no corner-drag (which would skew w≠h); the
                // diameter is set in the properties panel instead. The handle is
                // owner-only — you don't drag-resize someone else's tent.
                <rect
                  x={px + w - 6}
                  y={py + h - 6}
                  width={12}
                  height={12}
                  fill="#fff"
                  stroke="#1c1c1c"
                  strokeWidth={1.5}
                  style={{ cursor: "nwse-resize" }}
                  onPointerDown={onResizeDown}
                />
              ) : null}
            </>
          ) : null}
        </g>
        {showName || showOwner ? (
          <g
            style={{ pointerEvents: "none", userSelect: "none" }}
            textAnchor="middle"
            // Run the label along the object's dominant (longer) axis, rotated
            // with it — then fold the angle so it's never upside down: always
            // readable from the bottom, or from the right for a length-dominant
            // (taller-than-wide) object.
            transform={`rotate(${labelAngle} ${cx} ${cy})`}
            // Tagged so the BM export can drop object names (given + occupant).
            data-map-label="1"
          >
            {showName ? (
              <text
                x={cx}
                y={showOwner ? cy - 7 : cy}
                dominantBaseline="central"
                fontSize={16}
                fontWeight={700}
                fill="#1c1c1c"
              >
                {o.name}
              </text>
            ) : null}
            {showOwner ? (
              <text
                x={cx}
                y={showName ? cy + 10 : cy}
                dominantBaseline="central"
                fontSize={showName ? 13 : 15}
                fontWeight={showName ? 400 : 600}
                fill={showName ? "#868e96" : "#1c1c1c"}
              >
                {ownerFirst}
              </text>
            ) : null}
          </g>
        ) : null}
      </g>
    );
  },
  (prev, next) =>
    prev.o === next.o &&
    prev.selected === next.selected &&
    prev.soleSelected === next.soleSelected &&
    prev.editable === next.editable &&
    prev.resizable === next.resizable &&
    prev.rotateArmed === next.rotateArmed &&
    prev.dim === next.dim &&
    prev.overflow === next.overflow &&
    prev.showDoors === next.showDoors &&
    prev.night === next.night &&
    prev.originX === next.originX &&
    prev.originY === next.originY &&
    prev.ppf === next.ppf,
);
