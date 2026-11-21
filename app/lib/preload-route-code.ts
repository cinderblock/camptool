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
 * Only what's needed for the page being opened is fetched, so this costs no
 * extra data. Never throws into the app.
 */
import { useContext, useEffect, useRef } from "react";
import {
  UNSAFE_DataRouterContext as DataRouterContext,
  UNSAFE_FrameworkContext as FrameworkContext,
  matchRoutes,
  useNavigation,
} from "react-router";

const preloaded = new Set<string>();

function preloadModule(href: string) {
  if (preloaded.has(href)) return;
  preloaded.add(href);
  const link = document.createElement("link");
  link.rel = "modulepreload";
  link.href = href;
  document.head.appendChild(link);
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
