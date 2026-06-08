/**
 * Black Rock City geometry — client-safe (no server imports), shared by the map
 * editor's lot form and its render math.
 *
 * BRC is concentric arcs centered on the Man, so a camp is a radial wedge. The
 * lettered annular streets keep their LETTER year to year (Atwood = A, Bradbury
 * = B, …) but get renamed every year, and the exact radii/block depths shift as
 * BMorg republishes the measurements doc. So we model geometry **per year**: pick
 * a year + street letter and the frontage radius is derived; a manual override on
 * the placement still wins for odd lots (keyholes, plazas) until we model those.
 *
 * The 2025 numbers are reconstructed parametrically from the BMorg 2025
 * measurements (block depths + street widths) and reproduce every center-radius
 * data point validated in plans/camptool.md (A 2935, B 3215, E ≈4060, F 4545,
 * G 4825) plus the Kilgore outer-road checksum (≈5755 → 11,510′ diameter).
 */

export type StreetDef = {
  /** Stable identity across years: "esplanade" or a letter "A".."L". */
  code: string;
  /** Per-year display name (cosmetic). "" when we don't have that year's name. */
  name: string;
  widthFt: number;
  /** Block depth between the previous street's outer edge and this street's
   * inner edge. 0 for Esplanade (the innermost). */
  blockBeforeFt: number;
};

export type CityGeometry = {
  year: number;
  esplanadeCenterFt: number;
  streets: StreetDef[];
};

const CITY_2025: CityGeometry = {
  year: 2025,
  esplanadeCenterFt: 2500,
  streets: [
    { code: "esplanade", name: "Esplanade", widthFt: 40, blockBeforeFt: 0 },
    { code: "A", name: "Atwood", widthFt: 30, blockBeforeFt: 400 },
    { code: "B", name: "Bradbury", widthFt: 30, blockBeforeFt: 250 },
    { code: "C", name: "", widthFt: 30, blockBeforeFt: 250 },
    { code: "D", name: "", widthFt: 30, blockBeforeFt: 250 },
    { code: "E", name: "Ellison", widthFt: 40, blockBeforeFt: 250 },
    // Mid-city double block Ellison→Farmer = 450′.
    { code: "F", name: "Farmer", widthFt: 30, blockBeforeFt: 450 },
    { code: "G", name: "Gibson", widthFt: 30, blockBeforeFt: 250 },
    { code: "H", name: "", widthFt: 30, blockBeforeFt: 250 },
    { code: "I", name: "Ishiguro", widthFt: 30, blockBeforeFt: 250 },
    { code: "J", name: "", widthFt: 30, blockBeforeFt: 150 },
    { code: "K", name: "Kilgore", widthFt: 50, blockBeforeFt: 150 },
  ],
};

export const CITY_GEOMETRY: Record<number, CityGeometry> = { 2025: CITY_2025 };

/** Years we have actual BMorg measurements for, newest first. */
export const BRC_YEARS = Object.keys(CITY_GEOMETRY)
  .map(Number)
  .sort((a, b) => b - a);

/** The current event year — default for new editions / lot setup. BRC republishes
 * its measurements each year; until the current year's doc is loaded into
 * CITY_GEOMETRY, radius derivation falls back to the latest year we have (see
 * geometryYearFor). */
export const CURRENT_EVENT_YEAR = new Date().getFullYear();

/** Event years offered in pickers (not limited to geometry years). */
export const EVENT_YEARS = (() => {
  const out: number[] = [];
  for (let y = CURRENT_EVENT_YEAR + 1; y >= 2023; y--) out.push(y);
  return out;
})();

export const eventYearOptions = EVENT_YEARS.map(String);

/** Which geometry year to use for a given event year: that year if we have its
 * measurements, else the newest year at/below it, else the newest we have. */
export function geometryYearFor(
  year: number | null | undefined,
): number | null {
  if (year != null && CENTERS_BY_YEAR[year]) return year;
  if (year != null) {
    const atOrBelow = BRC_YEARS.find((y) => y <= year);
    if (atOrBelow != null) return atOrBelow;
  }
  return BRC_YEARS[0] ?? null;
}

/** True when we have that exact year's measurements (vs falling back). */
export function hasGeometry(year: number | null | undefined): boolean {
  return year != null && Boolean(CENTERS_BY_YEAR[year]);
}

/** Street-center radii (ft from the Man) by code, for one year's geometry. */
function centersOf(geo: CityGeometry): Map<string, number> {
  const out = new Map<string, number>();
  let prevOuter = 0;
  geo.streets.forEach((s, i) => {
    const center =
      i === 0
        ? geo.esplanadeCenterFt
        : prevOuter + s.blockBeforeFt + s.widthFt / 2;
    out.set(s.code, center);
    prevOuter = center + s.widthFt / 2;
  });
  return out;
}

const CENTERS_BY_YEAR: Record<number, Map<string, number>> = Object.fromEntries(
  Object.entries(CITY_GEOMETRY).map(([y, g]) => [Number(y), centersOf(g)]),
);

/** Distance from the Man to a street's center, or null if unknown. Falls back to
 * the nearest year we have measurements for when `year`'s doc isn't loaded. */
export function radiusForStreet(
  year: number | null | undefined,
  code: string | null | undefined,
): number | null {
  if (!code) return null;
  const gy = geometryYearFor(year);
  if (gy == null) return null;
  return CENTERS_BY_YEAR[gy]?.get(code) ?? null;
}

export function streetLabel(year: number, code: string): string {
  const gy = geometryYearFor(year) ?? year;
  const s = CITY_GEOMETRY[gy]?.streets.find((x) => x.code === code);
  const base = code === "esplanade" ? "Esplanade" : code;
  if (!s) return base;
  return s.name ? `${base} · ${s.name}` : base;
}

export function streetOptions(
  year: number,
): Array<{ value: string; label: string }> {
  const gy = geometryYearFor(year);
  const geo = gy == null ? undefined : CITY_GEOMETRY[gy];
  if (!geo) return [];
  return geo.streets.map((s) => ({
    value: s.code,
    label: streetLabel(year, s.code),
  }));
}

/** 15-minute clock addresses across the camp arc (2:00 → 10:00). The address
 * field accepts anything parseClock understands, so off-grid values (3:14) are
 * fine — these are just the suggestions. */
export function clockOptions(): string[] {
  const out: string[] = [];
  for (let h = 2; h <= 10; h++) {
    for (const mm of [0, 15, 30, 45]) {
      if (h === 10 && mm > 0) break;
      out.push(`${h}:${String(mm).padStart(2, "0")}`);
    }
  }
  return out;
}

/** Parse a clock address like "3:00", "4:30", or "3:14" to decimal hours
 * (1–12), else null. */
export function parseClock(addr: string | null): number | null {
  if (!addr) return null;
  const m = addr.match(/^\s*(\d{1,2})(?::(\d{1,2}))?/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  if (h < 1 || h > 12 || mm > 59) return null;
  return h + mm / 60;
}

/**
 * Compass bearing (deg from true north) the map's "up" points to. Map-up faces
 * across the frontage; for a Man-facing camp that's toward the Man — a 3:00 camp
 * faces NE (45°), so bearing = (135 − 30·h). A mountain-facing camp fronts the
 * outward street, so its up points away from the Man (+180°).
 */
export function mapUpBearingFor(
  addr: string | null,
  frontsToMan = true,
): number | null {
  const h = parseClock(addr);
  if (h == null) return null;
  const base = (((135 - 30 * h) % 360) + 360) % 360;
  return frontsToMan ? base : (base + 180) % 360;
}
