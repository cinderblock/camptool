import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("login", "routes/login.tsx"),
  route("c/:slug", "routes/c.$slug.tsx"),
  route("i/:token", "routes/i.$token.tsx"),
  route("impersonate", "routes/impersonate.tsx"),
  route("start", "routes/start.tsx"),
  route("api/auth/*", "routes/api.auth.$.tsx"),
  route("dashboard", "routes/dashboard/layout.tsx", [
    index("routes/dashboard/index.tsx"),
    route("members", "routes/dashboard/members.tsx"),
    route("invite", "routes/dashboard/invite.tsx"),
    route("editions", "routes/dashboard/editions.tsx"),
    route("map", "routes/dashboard/map.tsx"),
    route("bringing", "routes/dashboard/bringing.tsx"),
    route("inventory", "routes/dashboard/inventory.tsx"),
    route("tickets", "routes/dashboard/tickets.tsx"),
    route("passes", "routes/dashboard/passes.tsx"),
    route("recruits", "routes/dashboard/recruits.tsx"),
    route("onboarding", "routes/dashboard/onboarding.tsx"),
    route("admin", "routes/dashboard/admin.tsx"),
  ]),
] satisfies RouteConfig;
