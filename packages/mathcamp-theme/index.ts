/**
 * @camptool/mathcamp-theme — Math Camp @ Group W's bespoke deployment theme,
 * and the worked example of a per-deployment camp-theme package (Phase 2.5).
 *
 * Bundle it by naming it at build time: `CAMP_THEME=@camptool/mathcamp-theme`
 * makes it server-wide (every camp), `CAMP_THEMES=@camptool/mathcamp-theme`
 * makes it available for a super admin to switch on per camp (see
 * `app/theme/index.ts`). Camp-specific structures live here so they never bloat
 * the shared open-source palette.
 */
import type { CampTheme } from "@camptool/theme-contract";
import { hyparShade } from "./structures/hypar-shade";
import { sierpinskiPyramid } from "./structures/sierpinski";

const theme: CampTheme = {
  name: "Math Camp structures",
  structures: [sierpinskiPyramid, hyparShade],
};

export default theme;
