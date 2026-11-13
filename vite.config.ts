import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type Plugin } from "vite";

const publicHost = process.env.PUBLIC_BASE_URL
  ? new URL(process.env.PUBLIC_BASE_URL).hostname
  : undefined;

// Camp-theme packs (Phase 2.5, per camp since plans/hosting-other-camps.md).
// `app/theme/packs.ts` is replaced at build time by a module importing every
// pack named here. CAMP_THEME = server-wide packs (every camp; how a single-camp
// deployment has always worked). CAMP_THEMES = packs a super admin switches on
// per camp. Both are comma lists of workspace package names. The built-in
// default theme is always bundled, server-wide.
const DEFAULT_THEME = "@camptool/default-theme";
const themeList = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const globalThemes = [
  ...new Set([DEFAULT_THEME, ...themeList(process.env.CAMP_THEME)]),
];
const perCampThemes = themeList(process.env.CAMP_THEMES).filter(
  (t) => !globalThemes.includes(t),
);

function campThemePacks(): Plugin {
  const target = resolve(import.meta.dirname, "app/theme/packs.ts");
  return {
    name: "camp-theme-packs",
    enforce: "pre",
    load(id) {
      if (resolve(id.split("?")[0]) !== target) return null;
      const all = [
        ...globalThemes.map((key) => ({ key, global: true })),
        ...perCampThemes.map((key) => ({ key, global: false })),
      ];
      const imports = all
        .map((p, i) => `import t${i} from ${JSON.stringify(p.key)};`)
        .join("\n");
      const entries = all
        .map(
          (p, i) =>
            `{ key: ${JSON.stringify(p.key)}, theme: t${i}, global: ${p.global} }`,
        )
        .join(",\n  ");
      return `${imports}\nexport const PACKS = [\n  ${entries},\n];\n`;
    },
  };
}

// Which host the server build targets (plans/hosting-other-camps.md). Default:
// Bun (server.ts). `CAMPTOOL_TARGET=cloudflare`: a Worker (workers/app.ts),
// with the SSR environment running in workerd, where the `workerd` import
// condition picks D1/R2 for `#host/db` and `#host/blobs`.
const onCloudflare = process.env.CAMPTOOL_TARGET === "cloudflare";

export default defineConfig({
  plugins: [
    campThemePacks(),
    ...(onCloudflare ? [cloudflare({ viteEnvironment: { name: "ssr" } })] : []),
    reactRouter(),
  ],
  // tsconfigPaths: Vite 8 resolves tsconfig "paths" natively (replaces vite-tsconfig-paths).
  resolve: { tsconfigPaths: true },
  server: {
    // Uncommon default on purpose (see app/lib/env.server.ts — keep in sync):
    // 3000/5173 collide with other dev apps, and Windows Hyper-V reserves
    // port ranges around 3000 that make Vite walk the whole 3000s.
    port: Number(process.env.PORT ?? 17923),
    // With camp subdomains, every <slug>.<host> too (a leading dot is Vite's
    // "and its subdomains").
    allowedHosts: publicHost
      ? process.env.CAMP_SUBDOMAINS === "1"
        ? [publicHost, `.${publicHost}`]
        : [publicHost]
      : undefined,
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
