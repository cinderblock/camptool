import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const publicHost = process.env.PUBLIC_BASE_URL
  ? new URL(process.env.PUBLIC_BASE_URL).hostname
  : undefined;

// Camp-theme seam (Phase 2.5). Core imports the built-in `@camptool/default-theme`
// through `~/theme`; if CAMP_THEME names a different (workspace) package, alias
// that import to it so the active theme is swapped in at build time. Both satisfy
// the same `CampTheme` contract, so the swap is type-identical. Default = built-in.
const campTheme = process.env.CAMP_THEME;
const themeAlias =
  campTheme && campTheme !== "@camptool/default-theme"
    ? { "@camptool/default-theme": campTheme }
    : {};

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  resolve: { alias: themeAlias },
  server: {
    // Uncommon default on purpose (see app/lib/env.server.ts — keep in sync):
    // 3000/5173 collide with other dev apps, and Windows Hyper-V reserves
    // port ranges around 3000 that make Vite walk the whole 3000s.
    port: Number(process.env.PORT ?? 17923),
    allowedHosts: publicHost ? [publicHost] : undefined,
  },
  // We use the Drizzle adapter, never Kysely. better-auth still references the
  // optional `@better-auth/kysely-adapter`, which imports symbols dropped in
  // kysely 0.29 — so Vite's dep optimizer crashes trying to prebundle it. It's
  // never used at runtime, so keep it out of optimization entirely.
  optimizeDeps: {
    exclude: ["@better-auth/kysely-adapter", "kysely"],
    // Pre-bundle @mantine/dates (+ its dayjs peer) up front. Otherwise Vite
    // optimizes it on first interaction and momentarily serves it a second React
    // instance, throwing "Cannot read properties of null (reading 'useContext')"
    // in useMantineTheme the first time a DateInput popover opens.
    include: ["@mantine/dates", "dayjs"],
  },
});
