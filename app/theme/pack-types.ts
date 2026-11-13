import type { CampTheme } from "@camptool/theme-contract";

/** One bundled camp-theme package. */
export type ThemePack = {
  /** The package name, e.g. `@camptool/mathcamp-theme`. Stored per camp. */
  key: string;
  theme: CampTheme;
  /** Server-wide: every camp on this deployment gets it. Otherwise a super
   * admin switches it on per camp. */
  global: boolean;
};
