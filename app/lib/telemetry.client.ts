/**
 * Client-side telemetry (browser only). Keeps a small breadcrumb trail (recent
 * navigations + errors) for context, and forwards JS errors — uncaught,
 * unhandled promise rejections, and `console.error` — to `/api/log-error` so we
 * can trace what's breaking for users. The feedback form reuses `getBreadcrumbs`.
 *
 * Guards: never recurse (a failed forward must not log another error), dedupe
 * identical messages, and hard-cap how many we send per page load.
 */

export type Crumb = { t: number; type: string; data: string };

const MAX_CRUMBS = 30;
const crumbs: Crumb[] = [];

export function pushCrumb(type: string, data: string) {
  crumbs.push({ t: Date.now(), type, data: String(data).slice(0, 300) });
  if (crumbs.length > MAX_CRUMBS) crumbs.shift();
}

export function getBreadcrumbs(): Crumb[] {
  return crumbs.slice();
}

let installed = false;
let sent = 0;
let forwarding = false;
const MAX_SENT = 25;
const seen = new Set<string>();

function send(payload: unknown) {
  if (sent >= MAX_SENT) return;
  sent++;
  try {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        "/api/log-error",
        new Blob([body], { type: "application/json" }),
      );
    } else {
      void fetch("/api/log-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      });
    }
  } catch {
    // Forwarding must never throw back into the app.
  }
}

function record(
  kind: string,
  message: string,
  opts?: { stack?: string; source?: string; line?: number; col?: number },
) {
  if (forwarding) return; // don't log errors caused by logging
  const msg = String(message || "Unknown error");
  pushCrumb("error", `${kind}: ${msg}`);
  const key = `${kind}:${msg}:${opts?.source ?? ""}`;
  if (seen.has(key)) return; // already forwarded this exact one
  seen.add(key);
  forwarding = true;
  try {
    send({
      kind,
      message: msg.slice(0, 1000),
      stack: opts?.stack?.slice(0, 4000),
      source: opts?.source,
      line: opts?.line,
      col: opts?.col,
      url: location.pathname + location.search,
      breadcrumbs: getBreadcrumbs(),
    });
  } finally {
    forwarding = false;
  }
}

function safeStr(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function installTelemetry() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (e) => {
    record("error", e.message || "Script error", {
      stack: e.error?.stack,
      source: e.filename,
      line: e.lineno,
      col: e.colno,
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined;
    record("unhandledrejection", r?.message ?? safeStr(e.reason), {
      stack: r?.stack,
    });
  });

  // Forward console.error too (the user asked for "anything in the console").
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    orig(...args);
    try {
      const msg = args
        .map((a) =>
          a instanceof Error
            ? a.message
            : typeof a === "string"
              ? a
              : safeStr(a),
        )
        .join(" ");
      const err = args.find((a): a is Error => a instanceof Error);
      record("console", msg, { stack: err?.stack });
    } catch {
      // ignore
    }
  };
}
