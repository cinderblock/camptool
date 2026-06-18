/**
 * @camptool/default-theme — the built-in theme shipped with the open-source
 * app. It contributes no camp-specific structures; a self-hoster who wants
 * bespoke structures (or other customization) adds their own camp-theme
 * package and points `CAMP_THEME` at it. See `plans/camptool.md` Phase 2.5.
 */
import type { CampTheme } from "@camptool/theme-contract";

const theme: CampTheme = {
  structures: [],
};

export default theme;
