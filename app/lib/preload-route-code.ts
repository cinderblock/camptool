/**
 * Fetch a page's code all at once, from the moment a finger lands on its link.
 *
 * On a page switch React Router imports the page's module, and the browser
 * only learns what *that* imports once it arrives, then the same again a level
 * down: two or three network round trips in a row before the page can draw,
 * each one slow on a phone (plans/fast-navigation.md). The build's manifest
 * already lists every module a route needs, so this adds a
 * `<link rel="modulepreload">` for all of them together:
 *
 * - on `pointerdown` on an in-app link, which on a phone comes 50–150 ms
 *   before the tap counts as a click (React Router's own touch prefetch waits
 *   100 ms first, so on a quick tap it never starts);
 * - when any navigation starts, for links and programmatic navigations alike.
 *
 * Then, once a signed-in page has settled and the phone is idle, it fetches every
 * other page's code too, a few files at a time, so a first visit to any page
 * doesn't wait on the network either: about 400 KB compressed, once per deploy
 * (the files are cached for a year; public/_headers). Skipped when the visitor
 * asked to save data or is on a 2G-class connection.
 *
 * Never throws into the app.
 */
import { useContext, useEffect, useRef } from "react";
import {
  UNSAFE_DataRouterContext as DataRouterContext,
  UNSAFE_FrameworkContext as FrameworkContext,
  matchRoutes,
  useNavigation,
} from "react-router";

const preloaded = new Set<string>();

function preloadModule(href: string): Promise<void> | undefined {
  if (preloaded.has(href)) return;
  preloaded.add(href);
  const link = document.createElement("link");
  link.rel = "modulepreload";
  link.href = href;
  const done = new Promise<void>((resolve) => {
    link.onload = link.onerror = () => resolve();
  });
  document.head.appendChild(link);
  return done;
}

/** Start background work after the first page settles, when the phone's idle. */
const AFTER_LOAD_MS = 2_000;
/** Files in flight at once, so a tap's own fetches never queue behind these. */
const IDLE_BATCH = 4;

function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    if ("requestIdleCallback" in window) {
      requestIdleCallback(() => resolve(), { timeout: 2_000 });
    } else {
      setTimeout(resolve, 50);
    }
  });
}

function shouldSkipIdlePreload(): boolean {
  const c = (
    navigator as { connection?: { saveData?: boolean; effectiveType?: string } }
  ).connection;
  return !!c?.saveData || /(^|-)2g$/.test(c?.effectiveType ?? "");
}

export function usePreloadRouteCode() {
  const router = useContext(DataRouterContext)?.router;
  const manifest = useContext(FrameworkContext)?.manifest;
  const navigation = useNavigation();
  const preloadPath = useRef<(pathname: string) => void>(() => {});

  // Code the first page already loaded needn't be fetched again.
  useEffect(() => {
    for (const el of document.querySelectorAll<HTMLLinkElement>(
      'link[rel="modulepreload"]',
    )) {
      preloaded.add(new URL(el.href, location.href).pathname);
    }
  }, []);

  useEffect(() => {
    if (!router || !manifest) return;
    preloadPath.current = (pathname: string) => {
      try {
        for (const m of matchRoutes(router.routes, pathname) ?? []) {
          const route = manifest.routes[m.route.id];
          if (!route) continue;
          if (route.module) preloadModule(route.module);
          for (const href of route.imports ?? []) preloadModule(href);
        }
      } catch {
        // Preloading is only ever a head start.
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || a.target === "_blank") return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      preloadPath.current(url.pathname);
    };
    document.addEventListener("pointerdown", onPointerDown, {
      capture: true,
      passive: true,
    });
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
  }, [router, manifest]);

  // Any navigation (a link, a redirect, navigate() from code).
  useEffect(() => {
    const path = navigation.location?.pathname;
    if (path) preloadPath.current(path);
  }, [navigation.location?.pathname]);
}

/**
 * Every other page's code, in the background. Called from the signed-in layout
 * only, so a stranger opening a public page or the sign-in page doesn't pay for
 * the whole app.
 */
export function usePreloadAllRouteCode() {
  const manifest = useContext(FrameworkContext)?.manifest;
  useEffect(() => {
    if (!manifest || shouldSkipIdlePreload()) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const hrefs = new Set<string>();
        for (const route of Object.values(manifest.routes)) {
          if (!route) continue;
          if (route.module) hrefs.add(route.module);
          for (const href of route.imports ?? []) hrefs.add(href);
        }
        const queue = [...hrefs].filter((h) => !preloaded.has(h));
        while (queue.length && !cancelled) {
          await whenIdle();
          if (cancelled) return;
          await Promise.all(
            queue.splice(0, IDLE_BATCH).map((href) => preloadModule(href)),
          );
        }
      } catch {
        // Preloading is only ever a head start.
      }
    }, AFTER_LOAD_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [manifest]);
}
