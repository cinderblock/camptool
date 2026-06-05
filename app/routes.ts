import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("login", "routes/login.tsx"),
  route("api/auth/*", "routes/api.auth.$.tsx"),
  route("dashboard", "routes/dashboard/layout.tsx", [
    index("routes/dashboard/index.tsx"),
    route("members", "routes/dashboard/members.tsx"),
  ]),
] satisfies RouteConfig;
