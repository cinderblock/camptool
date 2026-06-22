/**
 * Prevailing-wind flow field for the camp map. Client-safe (no server imports),
 * like `sun.ts` / `brc.ts`.
 *
 * We approximate "wind around buildings" with a coarse **incompressible flow
 * solve** (a single pressure-projection step, à la Jos Stam's stable fluids):
 * start from a uniform wind, mark building footprints as solid, then project the
 * field to be divergence-free with no-penetration walls. The result wraps around
 * obstacles and goes slack in their lee — enough to read dust streams and wind
 * shadows, without a full Navier–Stokes simulation.
 */

/** Black Rock City's typical prevailing wind, as a *from* bearing (deg clockwise
 * from true north): winds usually come out of the south-southwest. The map lets
 * the user override this with the wind dial. */
export const BRC_WIND_FROM_BEARING = 220;

/** A solved flow field over a rectangular patch of plot-local feet. `u`/`v` are
 * the per-cell velocity components in the plot frame (+x right, +y into the lot),
 * in arbitrary units (the uniform inflow has magnitude `speed`). */
export type FlowField = {
  nx: number;
  ny: number;
  /** Feet coordinate of cell (0,0)'s center. */
  x0: number;
  y0: number;
  /** Cell size in feet. */
  cell: number;
  u: Float32Array;
  v: Float32Array;
  solid: Uint8Array;
};

/** True if point (px,py) is inside the polygon (ray-cast, even-odd). */
function pointInPoly(
  px: number,
  py: number,
  poly: ReadonlyArray<[number, number]>,
) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (!a || !b) continue;
    const [xi, yi] = a;
    const [xj, yj] = b;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Solve a flow field over the feet box [x0..x1]×[y0..y1]. `dir` is the unit
 * direction the wind travels in the plot frame; `speed` its magnitude.
 * `obstacles` are world (plot-local feet) footprint polygons. `cell` sets the
 * resolution. `iters` is the Gauss–Seidel count for the projection.
 *
 * Uses a **staggered (MAC) grid**: u lives on vertical cell faces, v on
 * horizontal faces. Wall faces (touching a solid cell) are pinned to zero flux,
 * and the incompressibility solve (Gauss–Seidel with over-relaxation, the
 * standard `s`-factor method) only moves the open faces — so flow can't pass
 * through buildings and instead accelerates around them with a slack lee. Border
 * cells keep the uniform inflow, making the domain edges open in/out.
 */
export function solveFlow(opts: {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cell: number;
  dir: { x: number; y: number };
  speed: number;
  obstacles: ReadonlyArray<ReadonlyArray<[number, number]>>;
  iters?: number;
}): FlowField {
  const { x0, y0, x1, y1, cell, dir, speed, obstacles } = opts;
  const iters = opts.iters ?? 40;
  const nx = Math.max(3, Math.ceil((x1 - x0) / cell));
  const ny = Math.max(3, Math.ceil((y1 - y0) / cell));
  const N = nx * ny;
  const solid = new Uint8Array(N);
  const c = (i: number, j: number) => i + j * nx;
  // Cell-center feet position.
  const fx = (i: number) => x0 + (i + 0.5) * cell;
  const fy = (j: number) => y0 + (j + 0.5) * cell;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cx = fx(i);
      const cy = fy(j);
      let blocked = false;
      for (const poly of obstacles) {
        if (pointInPoly(cx, cy, poly)) {
          blocked = true;
          break;
        }
      }
      solid[c(i, j)] = blocked ? 1 : 0;
    }
  }
  const isSolid = (i: number, j: number) =>
    i >= 0 && i < nx && j >= 0 && j < ny && solid[c(i, j)] === 1;

  // Staggered face velocities. u: (nx+1)×ny, v: nx×(ny+1).
  const ux = dir.x * speed;
  const uy = dir.y * speed;
  const uf = new Float32Array((nx + 1) * ny);
  const vf = new Float32Array(nx * (ny + 1));
  const ui = (i: number, j: number) => i + j * (nx + 1); // i in 0..nx
  const vi = (i: number, j: number) => i + j * nx; // j in 0..ny
  // A u-face between cells (i-1,j) and (i,j) is a wall (zero flux) if either side
  // is solid; otherwise it carries the uniform inflow.
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i <= nx; i++) {
      uf[ui(i, j)] = isSolid(i - 1, j) || isSolid(i, j) ? 0 : ux;
    }
  }
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i < nx; i++) {
      vf[vi(i, j)] = isSolid(i, j - 1) || isSolid(i, j) ? 0 : uy;
    }
  }

  // Incompressibility: redistribute divergence over the open faces of each
  // interior fluid cell. Border cells stay fixed (uniform inflow/outflow).
  const OVERRELAX = 1.9;
  for (let it = 0; it < iters; it++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        if (solid[c(i, j)]) continue;
        const sL = isSolid(i - 1, j) ? 0 : 1;
        const sR = isSolid(i + 1, j) ? 0 : 1;
        const sD = isSolid(i, j - 1) ? 0 : 1;
        const sU = isSolid(i, j + 1) ? 0 : 1;
        const sSum = sL + sR + sD + sU;
        if (sSum === 0) continue;
        const iR = ui(i + 1, j);
        const iL = ui(i, j);
        const jU = vi(i, j + 1);
        const jD = vi(i, j);
        const div =
          (uf[iR] ?? 0) - (uf[iL] ?? 0) + (vf[jU] ?? 0) - (vf[jD] ?? 0);
        const p = (-div / sSum) * OVERRELAX;
        uf[iL] = (uf[iL] ?? 0) - sL * p;
        uf[iR] = (uf[iR] ?? 0) + sR * p;
        vf[jD] = (vf[jD] ?? 0) - sD * p;
        vf[jU] = (vf[jU] ?? 0) + sU * p;
      }
    }
  }

  // Collapse to cell-centered velocity (average of opposing faces) for sampling.
  const u = new Float32Array(N);
  const v = new Float32Array(N);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = c(i, j);
      if (solid[k]) continue;
      u[k] = 0.5 * ((uf[ui(i, j)] ?? 0) + (uf[ui(i + 1, j)] ?? 0));
      v[k] = 0.5 * ((vf[vi(i, j)] ?? 0) + (vf[vi(i, j + 1)] ?? 0));
    }
  }

  return { nx, ny, x0: fx(0), y0: fy(0), cell, u, v, solid };
}

/** Bilinear velocity sample at feet (px,py). Returns {x,y} (0,0 inside a solid or
 * out of bounds). */
export function sampleFlow(
  f: FlowField,
  px: number,
  py: number,
): { x: number; y: number; solid: boolean } {
  const gx = (px - f.x0) / f.cell;
  const gy = (py - f.y0) / f.cell;
  const i0 = Math.floor(gx);
  const j0 = Math.floor(gy);
  if (i0 < 0 || j0 < 0 || i0 >= f.nx - 1 || j0 >= f.ny - 1) {
    return { x: 0, y: 0, solid: true };
  }
  const tx = gx - i0;
  const ty = gy - j0;
  const idx = (i: number, j: number) => i + j * f.nx;
  const k00 = idx(i0, j0);
  const k10 = idx(i0 + 1, j0);
  const k01 = idx(i0, j0 + 1);
  const k11 = idx(i0 + 1, j0 + 1);
  const anySolid = f.solid[k00] || f.solid[k10] || f.solid[k01] || f.solid[k11];
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const ux = lerp(
    lerp(f.u[k00] ?? 0, f.u[k10] ?? 0, tx),
    lerp(f.u[k01] ?? 0, f.u[k11] ?? 0, tx),
    ty,
  );
  const uy = lerp(
    lerp(f.v[k00] ?? 0, f.v[k10] ?? 0, tx),
    lerp(f.v[k01] ?? 0, f.v[k11] ?? 0, tx),
    ty,
  );
  return { x: ux, y: uy, solid: Boolean(anySolid) };
}
