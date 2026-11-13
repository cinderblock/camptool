/**
 * Cloudflare Workers entry: the counterpart of `server.ts` (Bun). Static
 * assets are served by the platform before this runs (wrangler.jsonc
 * `assets`), so this only answers `/_version` and hands the rest to React
 * Router. Database and uploads come from `#host/db` / `#host/blobs`, which the
 * `workerd` build condition points at D1 and R2 (plans/hosting-other-camps.md).
 */
import { env } from "cloudflare:workers";
import { createRequestHandler } from "react-router";

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
      return new Response(String(env.BUILD_SHA ?? "dev"), {
        headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
      });
    }
    return handler(request);
  },
};
