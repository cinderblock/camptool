/**
 * @camptool/mathcamp-theme — Math Camp @ Group W's bespoke deployment theme,
 * and the worked example of a per-deployment camp-theme package (Phase 2.5).
 *
 * Activate by setting `CAMP_THEME=@camptool/mathcamp-theme` in the environment;
 * Vite swaps this in for `@camptool/default-theme` at build time. Camp-specific
 * structures live here so they never bloat the shared open-source palette.
 */
import type { CampTheme } from "@camptool/theme-contract";
import { hyparShade } from "./structures/hypar-shade";
import { sierpinskiPyramid } from "./structures/sierpinski";

const theme: CampTheme = {
  structures: [sierpinskiPyramid, hyparShade],
};

export default theme;
