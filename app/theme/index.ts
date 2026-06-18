import activeTheme from "@camptool/default-theme";
/**
 * The active camp theme — the single point through which core code reads
 * per-deployment customization (Phase 2.5).
 *
 * Core always imports the built-in `@camptool/default-theme`; at build time, if
 * `CAMP_THEME` names a different package, Vite aliases that import to it (see
 * `vite.config.ts`). Both satisfy `CampTheme`, so the swap is type-identical.
 * Keep all camp-customization reads going through `~/theme`, never through a
 * specific package, so a self-hoster only flips one env var.
 */
import type { CampStructure, CampTheme } from "@camptool/theme-contract";

export const theme: CampTheme = activeTheme;

/** Custom structures the active camp theme contributes to the map palette. */
export const campStructures: readonly CampStructure[] = theme.structures;

export type { CampStructure, CampTheme } from "@camptool/theme-contract";
