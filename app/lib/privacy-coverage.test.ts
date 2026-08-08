/**
 * Coverage guard for privacy mode.
 *
 * Privacy mode redacts loader DATA (there is no shared display layer to hook —
 * see `plans/privacy-and-demo-mode.md`), which means a route added six months
 * from now leaks unless somebody remembers to wrap its return. Nobody will
 * remember. So: read `app/routes.ts`, and fail if any route with a loader
 * neither wraps its payload in `redact(privacy, …)` nor appears below with a
 * stated reason.
 *
 * Adding a route to EXEMPT is a deliberate act with a written justification,
 * which is the point — the default is "covered".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");

/** Routes with a loader that deliberately does NOT redact, and why. */
const EXEMPT: Record<string, string> = {
  "routes/login.tsx": "Sign-in page; renders no camp data.",
  "routes/api.auth.$.tsx": "better-auth passthrough; not our payload shape.",
  "routes/export-db.tsx":
    "Raw SQLite bytes can't be transformed in flight — privacy mode refuses " +
    "this route outright instead (409).",
  "routes/api.dev.errors.tsx":
    "Token-gated ops API (DEV_API_TOKEN), not a UI surface. Reads real " +
    "telemetry on purpose — that is the whole point of the endpoint.",
  "routes/api.dev.feedback.tsx": "Token-gated ops API; same as api.dev.errors.",
  "routes/c.$slug.tsx":
    "Public camp page — shows only what the camp chose to publish, and has no " +
    "session to carry a privacy cookie.",
  "routes/c.$slug.schedule.tsx":
    "Public programming lineup; presenter names are published deliberately.",
  "routes/i.$token.tsx": "Public invite landing, reached without a session.",
  "routes/spike.passkey.tsx":
    "Dev-only passkey harness (its loader 404s in production) and it returns " +
    "no data at all — the loader exists purely to gate the route.",
};

function routeFiles(): string[] {
  const src = readFileSync(join(APP, "routes.ts"), "utf8");
  return [...src.matchAll(/"(routes\/[^"]+\.tsx)"/g)].map(
    (m) => m[1] as string,
  );
}

describe("privacy coverage", () => {
  const files = routeFiles();

  test("routes.ts parses into a plausible route list", () => {
    // Guards against the regex silently matching nothing and the suite below
    // passing vacuously.
    expect(files.length).toBeGreaterThan(25);
    expect(files).toContain("routes/dashboard/members.tsx");
  });

  test("every route with a loader redacts, or is exempt with a reason", () => {
    const unwrapped: string[] = [];
    for (const rel of files) {
      const src = readFileSync(join(APP, rel), "utf8");
      if (!/export\s+(async\s+)?function\s+loader\b/.test(src)) continue;
      if (rel in EXEMPT) continue;
      if (!src.includes("redact(privacy")) unwrapped.push(rel);
    }
    expect(unwrapped).toEqual([]);
  });

  test("no stale exemptions", () => {
    const stale = Object.keys(EXEMPT).filter((rel) => !files.includes(rel));
    expect(stale).toEqual([]);
  });

  test("exemptions carry a real justification", () => {
    for (const [rel, why] of Object.entries(EXEMPT)) {
      expect(why.length, `${rel} needs a reason`).toBeGreaterThan(20);
    }
  });

  test("every route file on disk is registered in routes.ts", () => {
    // A route module that exists but isn't in routes.ts can't be reached today,
    // but would sail past the loader check above the moment someone wires it up.
    const walk = (dir: string, prefix: string): string[] =>
      readdirSync(join(APP, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(`${dir}/${e.name}`, `${prefix}${e.name}/`)
          : e.name.endsWith(".tsx")
            ? [`${prefix}${e.name}`]
            : [],
      );
    const onDisk = walk("routes", "routes/");
    expect(onDisk.filter((f) => !files.includes(f))).toEqual([]);
  });
});
