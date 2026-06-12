import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const publicHost = process.env.PUBLIC_BASE_URL
  ? new URL(process.env.PUBLIC_BASE_URL).hostname
  : undefined;

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  server: {
    port: Number(process.env.PORT ?? 3000),
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
