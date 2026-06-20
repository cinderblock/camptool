/**
 * @camptool/theme-contract — the typed contract a per-deployment camp-theme
 * package implements. Types only (no runtime), so both the core app and a
 * camp-theme package can depend on it without an app↔package import cycle.
 *
 * A self-hoster customizes their CampTool deployment by adding a workspace
 * package that exports a `CampTheme` and pointing the `CAMP_THEME` env var at
 * it (default → the built-in `@camptool/default-theme`). The core app imports
 * the active theme through the single `~/theme` module, so upstream upgrades
 * stay non-breaking and a camp overrides only what it wants.
 *
 * See `plans/camp-theme-and-custom-structures.md` and Phase 2.5 in
 * `plans/camptool.md`.
 */
import type { ReactNode } from "react";

/** Footprint shape a map structure draws as. `"custom"` defers to the kind's
 * own `renderFootprint` (used by camp-theme structures); the rest are core
 * built-ins drawn by the map editor's shape branch. */
export type ShapeKind = "rect" | "hexagon" | "hypar" | "dome" | "custom";

/** Highlight categories an object can belong to (a kind may carry several — an
 * RV is both a domicile and a vehicle). Drives the map's highlight filter. */
export type KindTag = "domicile" | "vehicle" | "structure";

/** A palette entry: a kind of thing that can be placed on the camp map. Both
 * the core built-in kinds and camp-theme custom structures share this shape. */
export type Kind = {
  value: string;
  label: string;
  color: string;
  /** Default footprint size in feet (w = along frontage, h = into the lot). */
  w: number;
  h: number;
  shape: ShapeKind;
  /** Fixed width, length-only resize (vehicles). */
  vehicle: boolean;
  /** No free resize at all. */
  rigid: boolean;
  /** Legend grouping heading. */
  group: string;
  /** Highlight categories this kind belongs to. */
  tags: readonly KindTag[];
  /** A camper may declare this for themselves (Bringing / wizard). Communal
   * infrastructure is officer-placed only and stays out of the camper palette. */
  personal: boolean;
};

/** Context handed to a custom structure's footprint renderer. Everything is in
 * the object's **plot-local feet** box: (0,0) top-left → (w,h) bottom-right —
 * the same coordinate space the core map uses for its built-in shapes, so a
 * custom footprint composes with drag/resize/rotate for free. */
export type FootprintCtx = {
  /** Object width/height in feet (post-resize). */
  w: number;
  h: number;
  /** The object's effective color. */
  color: string;
  /** Whether the object is currently selected (for emphasis). */
  selected: boolean;
  /** The object's rotation in degrees. The footprint is drawn inside the rotated
   * group, so a renderer that wants map-upright text (labels) should counter-
   * rotate it by `-rotation` about its anchor. */
  rotation: number;
};

/**
 * A vertex of a custom structure's 3D silhouette, for the shade simulation.
 * `x`/`y` are feet in the object-local **centered** frame (origin = the object's
 * center, +x along frontage, +y into the lot), pre-rotation; `z` is height as a
 * fraction (0..1) of the object's `tallFt`. The core casts the convex hull of
 * these vertices projected away from the sun, so a structure throws its true
 * silhouette (a solid tetrahedron casts a tetrahedron shadow) instead of an
 * extruded bounding box.
 */
export type ShadowVertex = { x: number; y: number; z: number };

/**
 * Unit direction toward the sun, in a structure's object-local footprint frame:
 * `x` along +w (frontage-right), `y` along +h (into the lot), `up` = out of the
 * ground (= sin of the sun's altitude). Passed to `shadedFaces` so a structure
 * can decide which of its faces are turned away from the sun.
 */
export type SunDir = { x: number; y: number; up: number };

/**
 * A camp-specific structure contributed by a camp-theme package into the map
 * palette registry. Extends a core `Kind` with optional bespoke renderers; when
 * `renderFootprint` is present the core map draws via it instead of the
 * built-in shape branch (set `shape: "custom"`). Camp-specific labels/geometry
 * may be hardcoded here — the package is per-deployment, not shared.
 */
export type CampStructure = Kind & {
  /** Default above-ground height (feet), seeded onto new objects and used by the
   * shade simulation. */
  tallFt?: number;
  /** SVG footprint, drawn in the 0,0→(w,h) feet box. Set `shape: "custom"`. */
  renderFootprint?: (ctx: FootprintCtx) => ReactNode;
  /** Optional legend/tray icon (square, `size` px). Falls back to a generic
   * glyph derived from the footprint when omitted. */
  renderIcon?: (size: number) => ReactNode;
  /** Optional 3D silhouette for the shade sim (object-local centered feet +
   * height fraction). When present, the core casts the convex hull of these
   * vertices projected away from the sun instead of extruding the footprint's
   * bounding box — so a non-box solid (e.g. a tetrahedron) casts its real shadow. */
  shadowVolume?: (w: number, h: number) => readonly ShadowVertex[];
  /** Optional self-shading overlay: given the sun's local direction, return each
   * upward face as a footprint polygon (feet, in the 0,0→(w,h) box) with a
   * continuous `shade` ∈ [0,1] = the dark-overlay opacity for that face (e.g. a
   * Lambert term, darker as the face turns from the sun). Core tints each polygon
   * at that opacity, so a face's shade rises smoothly rather than snapping on.
   * Only called when the shade sim is on. */
  shadedFaces?: (
    w: number,
    h: number,
    sun: SunDir,
  ) => ReadonlyArray<{
    points: ReadonlyArray<{ x: number; y: number }>;
    shade: number;
  }>;
};

/**
 * The contract a camp-theme package exports. Only `structures` is consumed
 * today; the remaining Phase 2.5 surface (Mantine theme, named slot overrides,
 * extra routes, a root provider) is reserved so the contract can grow without
 * breaking existing themes.
 */
export type CampTheme = {
  /** Custom structures added to the map palette. */
  structures: readonly CampStructure[];
  // Reserved Phase 2.5 surface (typed when built):
  // mantineTheme?: MantineThemeOverride;
  // slots?: Record<string, ComponentType<unknown>>;
  // routes?: unknown;
  // rootProvider?: ComponentType<{ children: ReactNode }>;
};
