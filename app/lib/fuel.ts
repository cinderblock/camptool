/**
 * Fuel — pure catalogs + totals (client-safe, no server imports). Pairs with
 * db/schema/fuel.ts.
 *
 * The point of this module is the safety review. Burning Man requires fuel to
 * have secondary containment and to be kept away from living areas and ignition
 * sources, and the map already draws the separation rings around a
 * `fuel-storage` object (10′ ignition, 20′ liquid↔propane, 50′ fuel↔fuel). What
 * nobody could answer was *how much* and *in how many containers*. These
 * helpers produce exactly those two numbers, per fuel type.
 *
 * Amounts are NOT normalized across units. Propane is bought and discussed in
 * pounds and gasoline in gallons; converting between them would invent
 * precision nobody supplied, and the separation rule that matters is
 * liquid-versus-gas, not a combined volume.
 */

export type FuelType = "gasoline" | "diesel" | "propane" | "other";
export type FuelUnit = "gal" | "lb";

/**
 * "I'm not bringing any" — a declaration row carrying this fuel type.
 *
 * Silence and "none" look identical in a table of fuel lines, and they are not
 * the same thing: one is a camper who has thought about it and has nothing to
 * store, the other is someone nobody has heard from. The safety review only
 * needs to chase the second group, so it has to be able to tell them apart.
 *
 * Deliberately NOT a member of `FUEL_TYPES`: it isn't a fuel, it never appears
 * in the type picker, and `isFuelType` rejects it so an ordinary fuel line can
 * never be edited into one. It contributes no amount and no containers.
 */
export const NO_FUEL = "none";

export function isNoFuel(type: string): boolean {
  return type === NO_FUEL;
}

export const FUEL_TYPES: {
  value: FuelType;
  label: string;
  /** Liquid fuels and compressed gas must be separated from each other. */
  phase: "liquid" | "gas";
  /** The unit people actually buy this in — the form's default. */
  unit: FuelUnit;
  color: string;
}[] = [
  {
    value: "gasoline",
    label: "Gasoline",
    phase: "liquid",
    unit: "gal",
    color: "red",
  },
  {
    value: "diesel",
    label: "Diesel",
    phase: "liquid",
    unit: "gal",
    color: "yellow",
  },
  {
    value: "propane",
    label: "Propane",
    phase: "gas",
    unit: "lb",
    color: "blue",
  },
  {
    value: "other",
    label: "Other",
    phase: "liquid",
    unit: "gal",
    color: "gray",
  },
];

export const FUEL_UNITS: { value: FuelUnit; label: string }[] = [
  { value: "gal", label: "gallons" },
  { value: "lb", label: "pounds" },
];

export function isFuelType(value: string): value is FuelType {
  return FUEL_TYPES.some((f) => f.value === value);
}

export function isFuelUnit(value: string): value is FuelUnit {
  return FUEL_UNITS.some((u) => u.value === value);
}

export function fuelLabel(type: string): string {
  if (isNoFuel(type)) return "No fuel";
  return FUEL_TYPES.find((f) => f.value === type)?.label ?? type;
}

export function fuelColor(type: string): string {
  return FUEL_TYPES.find((f) => f.value === type)?.color ?? "gray";
}

export function fuelPhase(type: string): "liquid" | "gas" {
  return FUEL_TYPES.find((f) => f.value === type)?.phase ?? "liquid";
}

/** The unit a fuel is normally bought in — what the form should default to. */
export function defaultUnitFor(type: string): FuelUnit {
  return FUEL_TYPES.find((f) => f.value === type)?.unit ?? "gal";
}

/** "12.5 gal" / "40 lb", without a trailing ".0". */
export function amountLabel(amount: number, unit: string): string {
  const n = Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
  return `${n} ${unit}`;
}

export type FuelRow = {
  fuelType: string;
  amount: number;
  unit: string;
  containerCount: number;
  secondaryContainment?: boolean | null;
};

export type FuelTotal = {
  fuelType: string;
  /** Summed per unit, because gallons and pounds don't add together. */
  byUnit: { unit: string; amount: number }[];
  containers: number;
  lines: number;
  /** Lines that haven't answered the containment question either way. */
  containmentUnknown: number;
  /** Lines that answered "no secondary containment" — the review's worry list. */
  containmentMissing: number;
};

/**
 * Totals per fuel type: how much (per unit) and how many containers. Types with
 * no declarations are omitted — a zero row is noise on a safety sheet.
 */
export function fuelTotals(rows: FuelRow[]): FuelTotal[] {
  const byType = new Map<string, FuelTotal>();
  for (const r of rows) {
    // A "none" declaration is an answer, not an amount — it belongs in the
    // count of who has answered, never in a total or a container count.
    if (isNoFuel(r.fuelType)) continue;
    const t = byType.get(r.fuelType) ?? {
      fuelType: r.fuelType,
      byUnit: [],
      containers: 0,
      lines: 0,
      containmentUnknown: 0,
      containmentMissing: 0,
    };
    const slot = t.byUnit.find((u) => u.unit === r.unit);
    if (slot) slot.amount += r.amount;
    else t.byUnit.push({ unit: r.unit, amount: r.amount });
    t.containers += r.containerCount;
    t.lines += 1;
    if (r.secondaryContainment == null) t.containmentUnknown += 1;
    else if (!r.secondaryContainment) t.containmentMissing += 1;
    byType.set(r.fuelType, t);
  }
  // Catalog order, so the sheet reads the same way every time.
  return FUEL_TYPES.map((f) => byType.get(f.value)).filter(
    (t): t is FuelTotal => !!t,
  );
}

/** How many lines are an explicit "not bringing any". */
export function noFuelCount(rows: { fuelType: string }[]): number {
  return rows.filter((r) => isNoFuel(r.fuelType)).length;
}

/** "12.5 gal" or, when a type arrived in both units, "12.5 gal + 40 lb". */
export function totalLabel(total: FuelTotal): string {
  return total.byUnit.map((u) => amountLabel(u.amount, u.unit)).join(" + ");
}

/**
 * Does the camp have both liquid fuel and compressed gas? If so the 20′
 * liquid↔propane separation applies and whoever lays out the fuel area needs to
 * know before they draw one storage zone for everything.
 */
export function needsPhaseSeparation(rows: FuelRow[]): boolean {
  const phases = new Set(
    rows
      .filter((r) => !isNoFuel(r.fuelType) && r.amount > 0)
      .map((r) => fuelPhase(r.fuelType)),
  );
  return phases.has("liquid") && phases.has("gas");
}
