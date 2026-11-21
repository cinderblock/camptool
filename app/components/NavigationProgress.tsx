/**
 * A thin bar across the top of the screen while a page switch is loading.
 *
 * Without it, tapping a link on a phone changed nothing on screen until the
 * next page's data arrived, which read as "the tap didn't work"
 * (plans/fast-navigation.md). It waits a moment before showing, so a fast
 * switch doesn't flash it.
 */
import { useEffect, useState } from "react";
import { useNavigation } from "react-router";

const SHOW_AFTER_MS = 120;

const css = `
.camptool-nav-progress {
  position: fixed;
  inset: 0 0 auto 0;
  height: 3px;
  z-index: 1000;
  overflow: hidden;
  pointer-events: none;
}
.camptool-nav-progress::before {
  content: "";
  position: absolute;
  inset: 0;
  width: 40%;
  background: var(--mantine-primary-color-filled);
  animation: camptool-nav-progress 1.1s ease-in-out infinite;
}
@keyframes camptool-nav-progress {
  from { transform: translateX(-100%); }
  to { transform: translateX(250%); }
}
@media (prefers-reduced-motion: reduce) {
  .camptool-nav-progress::before {
    width: 100%;
    animation: none;
    opacity: 0.6;
  }
}
`;

export function NavigationProgress() {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!busy) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  return (
    <>
      <style>{css}</style>
      {shown && (
        <div
          className="camptool-nav-progress"
          role="progressbar"
          aria-label="Loading page"
        />
      )}
    </>
  );
}
