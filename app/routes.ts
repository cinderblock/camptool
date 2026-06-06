import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("login", "routes/login.tsx"),
  route("c/:slug", "routes/c.$slug.tsx"),
  route("api/auth/*", "routes/api.auth.$.tsx"),
  route("dashboard", "routes/dashboard/layout.tsx", [
    index("routes/dashboard/index.tsx"),
    route("members", "routes/dashboard/members.tsx"),
    route("map", "routes/dashboard/map.tsx"),
    route("bringing", "routes/dashboard/bringing.tsx"),
    route("inventory", "routes/dashboard/inventory.tsx"),
    route("recruits", "routes/dashboard/recruits.tsx"),
    route("onboarding", "routes/dashboard/onboarding.tsx"),
  ]),
] satisfies RouteConfig;
