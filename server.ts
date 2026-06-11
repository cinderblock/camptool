// Production server: binds the React Router request handler DIRECTLY to a unix
// socket (no TCP port). The stock `react-router-serve` is port-only, so this
// ~tiny entry replaces it. Runs under Bun (the app uses `bun:sqlite`).
//
// Caddy (on the firefly host) reverse-proxies https://camptool.mathcamp.us/ to
// the socket below, passing X-Forwarded-Proto/-For and X-Real-IP.

import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createRequestHandler } from "react-router";

// The server build only exists after `bun run build`; it is not part of the
// typechecked sources (see tsconfig `include`).
import * as build from "./build/server/index.js";

const SOCKET_PATH = process.env.SOCKET_PATH ?? "/run/camptool/camptool.sock";
const CLIENT_DIR = `${import.meta.dir}/build/client`;

const handler = createRequestHandler(build, "production");

function serveAsset(pathname: string): Response | undefined {
  if (pathname === "/" || pathname.includes("..")) return undefined;
  const file = Bun.file(`${CLIENT_DIR}${pathname}`);
  // `new Response(file)` infers Content-Type from the extension; a 404 body is
  // streamed lazily, so an absent file just falls through to the SSR handler.
  if (!file.size) return undefined;
  const cacheControl = pathname.startsWith("/assets/")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=3600";
  return new Response(file, { headers: { "Cache-Control": cacheControl } });
}

// /run is tmpfs: ensure the dir exists and clear any stale socket before bind.
mkdirSync(dirname(SOCKET_PATH), { recursive: true });
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

Bun.serve({
  unix: SOCKET_PATH,
  fetch(req) {
    // Behind Caddy the wire protocol is plain HTTP over the socket; honor the
    // forwarded scheme so absolute URLs / auth callbacks resolve to https.
    const url = new URL(req.url);
    const proto = req.headers.get("x-forwarded-proto");
    if (proto) url.protocol = `${proto}:`;

    if (req.method === "GET" || req.method === "HEAD") {
      const asset = serveAsset(url.pathname);
      if (asset) return asset;
    }

    return handler(new Request(url, req));
  },
});

// Let root (Caddy) connect regardless of the container's runtime user.
try {
  chmodSync(SOCKET_PATH, 0o666);
} catch {}

console.log(`camptool listening on unix:${SOCKET_PATH}`);
