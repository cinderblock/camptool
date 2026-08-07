/** Tiny numeric helpers shared by the map renderer and its editor. */

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** Round to the nearest half — the granularity camp geometry is edited in. */
export function round(v: number) {
  return Math.round(v * 2) / 2;
}
