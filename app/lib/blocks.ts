/**
 * Premade "blocks": pre-arranged clusters of map objects an officer can drop onto
 * the lot in one action (then fine-tune). Client-safe (no server imports); the
 * map computes absolute positions from a drop point and the `addBlock` action
 * persists them. Offsets `dx`/`dy` are feet from the block's anchor (drop point);
 * each item's size defaults to its kind's default when `w`/`h` are omitted.
 */
export type BlockItem = {
  kind: string;
  dx: number;
  dy: number;
  w?: number;
  h?: number;
  rotation?: number;
  name?: string;
};

export type Block = {
  id: string;
  label: string;
  /** Item order = draw order (later = on top), e.g. a shade canopy goes last. */
  items: readonly BlockItem[];
};

export const BLOCKS: readonly Block[] = [
  {
    id: "kitchen",
    label: "Kitchen + shade",
    items: [
      { kind: "kitchen", dx: 0, dy: 0 },
      { kind: "shade", dx: 0, dy: 0, w: 24, h: 20 }, // canopy over the kitchen
    ],
  },
  {
    id: "shade-row",
    label: "Shade row (3)",
    items: [
      { kind: "shade", dx: -22, dy: 0 },
      { kind: "shade", dx: 0, dy: 0 },
      { kind: "shade", dx: 22, dy: 0 },
    ],
  },
  {
    id: "power",
    label: "Power station",
    items: [
      { kind: "power", dx: 0, dy: -7 }, // generator
      { kind: "spiderbox", dx: -9, dy: 6 },
      { kind: "spiderbox", dx: 9, dy: 6 },
    ],
  },
];

export function blockById(id: string): Block | undefined {
  return BLOCKS.find((b) => b.id === id);
}
