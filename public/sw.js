/*
 * CampTool's service worker (plans/pwa.md). Deliberately small: it only
 * replaces the browser's "no internet" error with a friendly page that
 * reloads itself when the connection comes back.
 *
 * It keeps nothing: no pages, no camp data (one person's camp must never show
 * after they sign out, and stale data would look current). Code files are
 * already in the browser's cache for a year (public/_headers). Everything
 * except a page load passes straight through, untouched.
 */

const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Offline · CampTool</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #fff; color: #212529; text-align: center; padding: 0 16px; }
  @media (prefers-color-scheme: dark) { body { background: #242424; color: #c9c9c9; } }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.25rem; color: #868e96; }
  button { font: inherit; padding: .5rem 1.25rem; border: 0; border-radius: 4px;
    background: #1971c2; color: #fff; }
</style></head>
<body><main>
  <h1>No connection</h1>
  <p>CampTool will open as soon as you're back online.</p>
  <button onclick="location.reload()">Try again</button>
</main>
<script>
  // Reload when the connection is back: on the browser's "online" signal, and
  // by checking every few seconds, since that signal isn't always sent.
  addEventListener("online", () => location.reload());
  setInterval(() => {
    fetch(location.href, { method: "HEAD", cache: "no-store" })
      .then(() => location.reload(), () => {});
  }, 5000);
</script>
</body></html>`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Start each page's request while the worker is still waking up, so
      // having a worker never makes a page load slower.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(event.request);
      } catch {
        return new Response(OFFLINE_HTML, {
          status: 503,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    })(),
  );
});
