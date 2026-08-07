/**
 * A small, read-only camp map — the lot outline plus every placed object, drawn
 * with the SAME renderer and geometry as the full editor (`lib/map-shapes.tsx`,
 * `lib/map-geometry.ts`). Used by the roster to show where a party is camped
 * without leaving the page.
 *
 * What it deliberately does NOT have: zoom, panning, drag, selection handles,
 * zones/cables/roads, wind and shadow overlays. Those belong to the editor. This
 * is a picture, not a workspace — the only interaction is choosing whose
 * structures to light up, which the parent owns.
 */
import {
  type MapLot,
  VIEW_W,
  layoutFor,
  lotPointsFor,
} from "~/lib/map-geometry";
import { MapObjectShape, MapShapeDefs, type ObjRow } from "~/lib/map-shapes";

/** Pointer handlers MapObjectShape requires but a read-only view never fires. */
const noop = () => {};

export function CampMapView({
  lot,
  objects,
  highlightIds,
  maxHeight = 380,
  label,
}: {
  lot: MapLot;
  objects: ObjRow[];
  /**
   * When non-null, these objects stay lit and everything else dims.
   *
   * The empty set is meaningful and NOT the same as null: it dims the whole
   * map, which is the honest answer for someone with nothing placed. Null means
   * "nobody is picked" and leaves the map at full brightness. Keeping the two
   * distinct is what stops the map flashing back to full brightness as the
   * pointer crosses rows for people who aren't on it.
   */
  highlightIds: Set<string> | null;
  /** Cap on the drawn height; the map keeps its aspect ratio within it. */
  maxHeight?: number;
  /** Accessible name — say whose map this is, since it's otherwise a picture. */
  label: string;
}) {
  const layout = layoutFor(lot);
  const { ppf, originX, originY, viewH } = layout;
  const lotPoints = lotPointsFor(lot, layout);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${viewH}`}
      // Fill the width and derive the height from the lot's own proportions,
      // capped — a fixed height letterboxes a deep lot into a useless sliver.
      // `aspectRatio` makes the cap shrink the width to match, not distort.
      style={{
        display: "block",
        width: "100%",
        height: "auto",
        aspectRatio: `${VIEW_W} / ${viewH}`,
        maxHeight,
        margin: "0 auto",
        touchAction: "auto",
      }}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {/* MapObjectShape fills hypar/hexayurt roofs from these — see its module
          header. Without them those roofs render flat and nobody notices. */}
      <defs>
        <MapShapeDefs />
      </defs>
      <polygon
        points={lotPoints}
        fill="var(--ct-map-ground)"
        stroke="var(--mantine-color-default-border)"
        strokeWidth={2}
      />
      {objects.map((o) => (
        <MapObjectShape
          key={o.id}
          o={o}
          originX={originX}
          originY={originY}
          ppf={ppf}
          selected={false}
          soleSelected={false}
          editable={false}
          resizable={false}
          rotateArmed={false}
          dim={highlightIds !== null && !highlightIds.has(o.id)}
          showDoors={false}
          overflow={false}
          night={false}
          onBodyDown={noop}
          onResizeDown={noop}
          onRotateDown={noop}
        />
      ))}
    </svg>
  );
}
