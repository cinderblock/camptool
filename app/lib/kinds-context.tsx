/**
 * The active camp's structure palette in the browser. The dashboard layout
 * loads the camp's own kinds (`loadCustomKinds`) and wraps the app in a
 * `KindsProvider`; components read the registry with `useKinds()`.
 * See plans/custom-structures.md.
 */
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { type CustomKindData, customKindRegistry } from "./custom-kinds";
import type { KindRegistry } from "./structures";

const KindsContext = createContext<KindRegistry | null>(null);

export function KindsProvider({
  kinds,
  children,
}: {
  kinds: readonly CustomKindData[];
  children: ReactNode;
}) {
  // Loader data is a fresh array after every revalidation; rebuild (and so
  // re-render every memoized map shape) only when the kinds actually changed.
  const key = JSON.stringify(kinds);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on content
  const registry = useMemo(() => customKindRegistry(kinds), [key]);
  return (
    <KindsContext.Provider value={registry}>{children}</KindsContext.Provider>
  );
}

/** The active camp's kinds. Throws outside a `KindsProvider`, so a page can't
 * quietly fall back to the built-ins and miss the camp's own kinds. */
export function useKinds(): KindRegistry {
  const registry = useContext(KindsContext);
  if (!registry) {
    throw new Error("useKinds() needs a <KindsProvider> above it.");
  }
  return registry;
}
