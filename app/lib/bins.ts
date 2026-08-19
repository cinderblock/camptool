/**
 * bins integration — pure helpers (see plans/bins-integration.md). Client-safe
 * and dependency-free, so the search behaviour can be unit-tested without
 * dragging in the DB client (importing anything `.server` runs the migrator).
 */

/** The fields we use from bins' `GET /api/v1/bins`. */
export type BinSummary = {
  id: number;
  name: string | null;
  status: string;
  locationName: string | null;
  externalLabel: string | null;
  labelIds: string[];
};

/**
 * "Which box is the X in" — the question a warehouse actually gets asked.
 * Every typed word must appear somewhere in the bin's name, external label,
 * location or labels; case-insensitive, order-independent. Deliberately AND
 * rather than OR: "gaff tape" should find the tape box, not every box with
 * any tape in it.
 */
export function searchBins(bins: BinSummary[], query: string): BinSummary[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return bins.filter((b) => {
    const hay = [b.name, b.externalLabel, b.locationName, ...b.labelIds]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A bin's human name, falling back to its number — bins allows unnamed boxes. */
export function binTitle(b: BinSummary): string {
  const name = b.name?.trim();
  return name ? name : `Bin ${b.id}`;
}

/** Deep link to one bin in the bins app. No sticker secret, so it lands on the
 * bin page for someone already signed in and on the landing page otherwise —
 * which is bins' own behaviour, not something to work around here. */
export function binHref(baseUrl: string, id: number): string {
  return `${baseUrl.replace(/\/+$/, "")}/${id}`;
}
