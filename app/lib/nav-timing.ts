/**
 * How long page loads and page switches take in real browsers, reported to
 * `/api/log-nav` (plans/fast-navigation.md). The server only sees its own
 * part; on a phone the rest (network, the page's code, drawing) is most of
 * it, so each switch is split into:
 *
 * - total: tap until the new page is drawn
 * - fetch: tap until the page's data is in hand (small when a prefetch on
 *   touch already had it), with the request's own time to first byte and how
 *   far ahead of the tap it started
 * - server / db / waits / colo: the response's Server-Timing
 * - code: tap until the last page-code chunk it needed arrived
 * - render: from data and code both in hand until drawn
 *
 * Uses only the Navigation / Resource Timing APIs, and only inside effects, so
 * the hook is safe to render on the server (hence not a `.client` module,
 * which the server build would empty). Never throws into the app.
 */
import { useEffect, useRef } from "react";
import { useLocation, useNavigation } from "react-router";

type Report = {
  kind: "load" | "nav";
  path: string;
  totalMs: number;
  fetchMs?: number;
  ttfbMs?: number;
  fetchLeadMs?: number;
  serverMs?: number;
  dbMs?: number;
  dbWaits?: number;
  colo?: string;
  codeMs?: number;
  renderMs?: number;
  netType?: string;
  netRttMs?: number;
};

const MAX_REPORTS = 300;
let reports = 0;

function send(r: Report) {
  if (reports >= MAX_REPORTS) return;
  reports++;
  try {
    const conn = (
      navigator as { connection?: { effectiveType?: string; rtt?: number } }
    ).connection;
    const body = JSON.stringify({
      ...r,
      netType: conn?.effectiveType,
      netRttMs: conn?.rtt,
    });
    const blob = new Blob([body], { type: "application/json" });
    if (!navigator.sendBeacon?.("/api/log-nav", blob)) {
      void fetch("/api/log-nav", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // Timing must never break the app.
  }
}

/** Server-Timing from a response: `db`, `total` and `colo` (d1-metrics.ts). */
function serverParts(entry: PerformanceResourceTiming | undefined) {
  const out: Pick<Report, "serverMs" | "dbMs" | "dbWaits" | "colo"> = {};
  for (const t of entry?.serverTiming ?? []) {
    if (t.name === "total") out.serverMs = t.duration;
    if (t.name === "db") {
      out.dbMs = t.duration;
      const waits = /(\d+) waits/.exec(t.description)?.[1];
      if (waits) out.dbWaits = Number(waits);
    }
    if (t.name === "colo") out.colo = t.description;
  }
  return out;
}

function resources(): PerformanceResourceTiming[] {
  return performance.getEntriesByType(
    "resource",
  ) as PerformanceResourceTiming[];
}

const isCode = (e: PerformanceResourceTiming) =>
  /\.m?js(\?|$)/.test(new URL(e.name, location.href).pathname);

/** When the page code needed since `from` finished arriving, if any. */
function codeDoneAt(from: number, to: number): number | undefined {
  let done: number | undefined;
  for (const e of resources()) {
    if (!isCode(e) || e.startTime < from || e.startTime > to) continue;
    done = Math.max(done ?? 0, e.responseEnd);
  }
  return done;
}

/** The single-fetch data URL path React Router asks for `path`. */
function dataPath(path: string): string {
  return path === "/" ? "/_root.data" : `${path.replace(/\/$/, "")}.data`;
}

function reportNav(path: string, target: string, start: number, end: number) {
  // The page that showed, or the one tapped when a redirect intervened.
  const want = new Set([dataPath(path), dataPath(target)]);
  const data = resources().filter(
    (e) =>
      want.has(new URL(e.name, location.href).pathname) &&
      e.startTime > start - 30_000 &&
      e.startTime <= end,
  );
  // The request the switch used (on or after the tap), and the one that went
  // over the network: a prefetch on touch, when the browser served the switch
  // from it.
  const used = data.filter((e) => e.startTime >= start - 50).at(-1);
  const network =
    [...data]
      .reverse()
      .find((e) => e.responseStart > 0 && e.transferSize > 0) ?? used;
  // Served from a prefetch, the switch's own request may not show up at all;
  // then the data was in hand when the prefetch finished.
  const dataDone = (used ?? network)?.responseEnd;
  const code = codeDoneAt(start - 2_000, end);
  const ready = Math.max(start, dataDone ?? start, code ?? start);
  send({
    kind: "nav",
    path,
    totalMs: end - start,
    fetchMs: dataDone != null ? Math.max(0, dataDone - start) : undefined,
    ttfbMs: network ? network.responseStart - network.startTime : undefined,
    fetchLeadMs: network ? start - network.startTime : undefined,
    ...serverParts(network?.serverTiming?.length ? network : used),
    codeMs: code != null ? Math.max(0, code - start) : undefined,
    renderMs: end - ready,
  });
}

function reportLoad(end: number) {
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (!nav) return;
  const code = codeDoneAt(0, end);
  send({
    kind: "load",
    path: location.pathname,
    totalMs: end,
    fetchMs: nav.responseEnd,
    ttfbMs: nav.responseStart - nav.requestStart,
    ...serverParts(nav),
    codeMs: code,
    renderMs: end - Math.max(nav.responseEnd, code ?? 0),
  });
}

/** Call once `fn` can run after the browser has drawn the current frame. */
function afterPaint(fn: () => void) {
  if (document.hidden) return; // no frames to wait for; skip the sample
  requestAnimationFrame(() => setTimeout(fn, 0));
}

/** Time the first load and every page switch inside the signed-in app. */
export function useNavTiming() {
  const navigation = useNavigation();
  const location = useLocation();
  const pending = useRef<{ start: number; path: string } | null>(null);

  useEffect(() => {
    try {
      performance.setResourceTimingBufferSize?.(1000);
    } catch {}
    afterPaint(() => reportLoad(performance.now()));
  }, []);

  // A link (or GET form) starts loading: that's the tap. Form posts are
  // actions, not page switches, so they aren't timed.
  useEffect(() => {
    if (
      navigation.state === "loading" &&
      !navigation.formMethod &&
      !pending.current
    ) {
      pending.current = {
        start: performance.now(),
        path: navigation.location.pathname,
      };
    }
  }, [navigation]);

  // Back to idle with the new page committed: time it once it's drawn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per location
  useEffect(() => {
    const p = pending.current;
    if (navigation.state !== "idle" || !p) return;
    pending.current = null;
    // A redirect lands elsewhere; time the page that actually showed.
    const path = location.pathname;
    afterPaint(() => {
      try {
        reportNav(path, p.path, p.start, performance.now());
        performance.clearResourceTimings();
      } catch {}
    });
  }, [navigation.state, location.key]);
}
