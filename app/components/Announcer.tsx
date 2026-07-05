/**
 * Global screen-reader announcer: one pair of visually-hidden live regions
 * mounted once in root, plus an `announce()` helper any component can call for
 * state changes that have no visible-text equivalent a screen reader would
 * catch (auto-saves, wizard step changes, calendar selections, reveals).
 * Mantine notifications and Alert already announce themselves — use this for
 * everything that isn't one of those.
 */
import { useEffect, useRef } from "react";

let politeEl: HTMLElement | null = null;
let assertiveEl: HTMLElement | null = null;

export function announce(
  message: string,
  opts?: { assertive?: boolean },
): void {
  const el = opts?.assertive ? assertiveEl : politeEl;
  if (!el) return;
  // Clear first so repeating the same message still triggers an announcement.
  el.textContent = "";
  window.setTimeout(() => {
    el.textContent = message;
  }, 30);
}

const visuallyHidden: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

export function Announcer() {
  const polite = useRef<HTMLDivElement>(null);
  const assertive = useRef<HTMLDivElement>(null);
  useEffect(() => {
    politeEl = polite.current;
    assertiveEl = assertive.current;
    return () => {
      politeEl = null;
      assertiveEl = null;
    };
  }, []);
  return (
    <>
      <div
        ref={polite}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={visuallyHidden}
      />
      <div
        ref={assertive}
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        style={visuallyHidden}
      />
    </>
  );
}

/** CSS for the skip link: visually hidden until keyboard-focused. Injected
 * once by <SkipLink> so no global stylesheet is needed. */
const skipLinkCss = `
.skip-link {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.skip-link:focus {
  position: fixed;
  top: 8px; left: 8px;
  width: auto; height: auto;
  padding: 8px 14px; margin: 0;
  clip-path: none;
  z-index: 10000;
  background: var(--mantine-color-blue-6);
  color: white;
  border-radius: 6px;
  text-decoration: none;
}
`;

/** Skip-to-content link — first focusable element on the page. Targets the
 * `#main-content` landmark that each page's <main> carries. */
export function SkipLink() {
  return (
    <>
      <style>{skipLinkCss}</style>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
    </>
  );
}
