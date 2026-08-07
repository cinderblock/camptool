/**
 * The spares board — pure catalogs + helpers (client-safe, no server imports).
 * Pairs with db/schema/swap.ts.
 *
 * Ticket and vehicle pass are separate kinds throughout, never a single
 * "spare": people routinely have one and need the other, and a board that
 * can't express that is the Discord thread it was meant to replace.
 */

export type SwapKind = "ticket" | "vehicle_pass";
export type SwapDirection = "have" | "need";
export type SwapStatus = "open" | "claimed" | "withdrawn";

export const SWAP_KINDS: {
  value: SwapKind;
  label: string;
  /** Singular/plural for counts, since "1 vehicle passes" reads badly. */
  one: string;
  many: string;
  color: string;
}[] = [
  {
    value: "ticket",
    label: "Ticket",
    one: "ticket",
    many: "tickets",
    color: "grape",
  },
  {
    value: "vehicle_pass",
    label: "Vehicle pass",
    one: "vehicle pass",
    many: "vehicle passes",
    color: "teal",
  },
];

export const SWAP_DIRECTIONS: {
  value: SwapDirection;
  label: string;
  /** How the listing reads in a sentence. */
  verb: string;
  color: string;
}[] = [
  { value: "have", label: "I have a spare", verb: "has", color: "green" },
  { value: "need", label: "I need one", verb: "needs", color: "orange" },
];

export function isSwapKind(value: string): value is SwapKind {
  return SWAP_KINDS.some((k) => k.value === value);
}

export function isSwapDirection(value: string): value is SwapDirection {
  return SWAP_DIRECTIONS.some((d) => d.value === value);
}

export function kindLabel(kind: string, quantity = 1): string {
  const k = SWAP_KINDS.find((x) => x.value === kind);
  if (!k) return kind;
  return quantity === 1 ? k.one : k.many;
}

export function kindColor(kind: string): string {
  return SWAP_KINDS.find((x) => x.value === kind)?.color ?? "gray";
}

export function directionColor(direction: string): string {
  return SWAP_DIRECTIONS.find((x) => x.value === direction)?.color ?? "gray";
}

/**
 * What the poster is asking. `null` means they didn't say — which is a real,
 * common answer ("make me an offer", "whatever you think"), distinct from free.
 */
export function priceLabel(cents: number | null): string {
  if (cents == null) return "price not stated";
  if (cents === 0) return "free";
  const dollars = cents / 100;
  return `$${
    Number.isInteger(dollars)
      ? dollars.toLocaleString()
      : dollars.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
  }`;
}

/**
 * Parse a typed price into integer cents. Accepts "$575", "575.00", "575",
 * " 1,200 ", and treats blank as "not stated" (null). Rejects negatives and
 * anything unparsable by returning null too — a board post is not worth a
 * validation argument, and "not stated" is a legitimate outcome.
 */
export function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** One line summarizing a listing, e.g. "2 tickets · $575 each". */
export function listingSummary(l: {
  kind: string;
  quantity: number;
  priceCents: number | null;
}): string {
  const what = `${l.quantity} ${kindLabel(l.kind, l.quantity)}`;
  const price = priceLabel(l.priceCents);
  return l.quantity > 1 && l.priceCents != null && l.priceCents > 0
    ? `${what} · ${price} each`
    : `${what} · ${price}`;
}

/**
 * Sort for the board: open listings before settled ones, "need" alongside
 * "have" (both are live asks), then newest first. A claimed listing staying
 * visible is deliberate — it's how someone learns the spare is gone rather
 * than messaging the poster again.
 */
export function compareListings(
  a: { status: string; createdAt: number },
  b: { status: string; createdAt: number },
): number {
  const rank = (s: string) => (s === "open" ? 0 : s === "claimed" ? 1 : 2);
  return rank(a.status) - rank(b.status) || b.createdAt - a.createdAt;
}
