/**
 * Cloudflare Workers entry: the counterpart of `server.ts` (Bun). Static
 * assets are served by the platform before this runs (wrangler.jsonc
 * `assets`), so this only answers `/_version`, applies the per-visitor
 * request limits (rate-limit.ts) and hands the rest to React Router. Database and uploads come from `#host/db` / `#host/blobs`, which the
 * `workerd` build condition points at D1 and R2 (plans/hosting-other-camps.md).
 */
import { env } from "cloudflare:workers";
import { createRequestHandler } from "react-router";
import { serverTiming, withDbMetrics } from "../db/host/d1-metrics";
import { type RateLimitEnv, rateLimitResponse } from "./rate-limit";

/** The commit this build came from (vite.config.ts), or "" outside CI. */
declare const __BUILD_SHA__: string;

const handler = createRequestHandler(
  // Provided by @cloudflare/vite-plugin + React Router at build time.
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Build marker for deploy checks, same contract as server.ts.
    if (url.pathname === "/_version") {
      return new Response(String(env.BUILD_SHA || __BUILD_SHA__ || "dev"), {
        headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
      });
    }
    const limited = await rateLimitResponse(
      env as RateLimitEnv,
      request,
      url.pathname,
    );
    if (limited) return limited;
    // Report how long the page waited on D1 (plans/fast-navigation.md): on
    // Workers every query is a round trip, so this is where time goes.
    const started = performance.now();
    const { result, metrics } = await withDbMetrics(() => handler(request));
    const response = new Response(result.body, result);
    response.headers.append(
      "Server-Timing",
      serverTiming(metrics, performance.now() - started),
    );
    return response;
  },
};
