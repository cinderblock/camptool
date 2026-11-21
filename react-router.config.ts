import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  // Ship the whole route list with the first page instead of discovering
  // routes as links appear. Discovery made a touch prefetch wait for a
  // /__manifest round trip, so on a phone it started after the tap and the
  // page's data was fetched twice (plans/fast-navigation.md). The list is a
  // few KB for our ~80 routes.
  routeDiscovery: { mode: "initial" },
} satisfies Config;
