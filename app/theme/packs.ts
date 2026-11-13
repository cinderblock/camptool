/**
 * The structure packs bundled into this build. **Generated at build time**:
 * the `camp-theme-packs` Vite plugin (`vite.config.ts`) replaces this module
 * with one that imports every package named in `CAMP_THEME` (server-wide) and
 * `CAMP_THEMES` (per camp). This checked-in version is what tests and any
 * non-Vite runtime see: just the built-in default theme.
 */
import defaultTheme from "@camptool/default-theme";
import type { ThemePack } from "./pack-types";

export const PACKS: readonly ThemePack[] = [
  { key: "@camptool/default-theme", theme: defaultTheme, global: true },
];
