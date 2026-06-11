// Web-streams SSR entry. The default React Router entry uses Node's
// `renderToPipeableStream`, which Bun's `react-dom/server` does not export
// (it provides `renderToReadableStream`). Since the production server runs
// under Bun (see `server.ts`), render to a web ReadableStream instead.

import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  let shellRendered = false;

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      onError(error: unknown) {
        responseStatusCode = 500;
        // Errors thrown after the shell rendered are logged but not surfaced,
        // since the response has already started streaming.
        if (shellRendered) {
          console.error(error);
        }
      },
    },
  );
  shellRendered = true;

  const userAgent = request.headers.get("user-agent");
  // Buffer the full document for bots (SEO) and in SPA mode.
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
