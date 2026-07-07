import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

export default [
  // Public / full-screen routes (no app shell).
  route("login", "routes/login.tsx"),
  route("c/:slug", "routes/c.$slug.tsx"),
  route("i/:token", "routes/i.$token.tsx"),
  route("impersonate", "routes/impersonate.tsx"),
  route("start", "routes/start.tsx"),
  // Super-admin DB backup download (resource route; self-gated).
  route("export-db", "routes/export-db.tsx"),
  route("api/auth/*", "routes/api.auth.$.tsx"),
  // Browser error forwarding (telemetry.client.ts → client_error table).
  route("api/log-error", "routes/api.log-error.tsx"),
  // User feedback submissions (FeedbackButton → feedback table).
  route("api/feedback", "routes/api.feedback.tsx"),
  // Dev-only telemetry read APIs (token-gated via DEV_API_TOKEN; for tracing).
  route("api/dev/errors", "routes/api.dev.errors.tsx"),
  route("api/dev/feedback", "routes/api.dev.feedback.tsx"),
  // The app itself lives at the root behind a pathless layout (the shell). The
  // layout loader requires a logged-in user, so "/" is either the overview or a
  // redirect to /login — there is no "/dashboard" segment.
  layout("routes/dashboard/layout.tsx", [
    index("routes/dashboard/index.tsx"),
    route("guide", "routes/dashboard/guide.tsx"),
    route("announcements", "routes/dashboard/announcements.tsx"),
    route("members", "routes/dashboard/members.tsx"),
    route("roster", "routes/dashboard/roster.tsx"),
    route("invite", "routes/dashboard/invite.tsx"),
    route("editions", "routes/dashboard/editions.tsx"),
    route("map", "routes/dashboard/map.tsx"),
    route("bringing", "routes/dashboard/bringing.tsx"),
    route("inventory", "routes/dashboard/inventory.tsx"),
    route("supplies", "routes/dashboard/supplies.tsx"),
    route("documents", "routes/dashboard/documents.tsx"),
    route("tickets", "routes/dashboard/tickets.tsx"),
    route("passes", "routes/dashboard/passes.tsx"),
    route("finances", "routes/dashboard/finances.tsx"),
    route("dues", "routes/dashboard/dues.tsx"),
    route("recruits", "routes/dashboard/recruits.tsx"),
    route("questions", "routes/dashboard/questions.tsx"),
    route("onboarding", "routes/dashboard/onboarding.tsx"),
    route("admin", "routes/dashboard/admin.tsx"),
  ]),
] satisfies RouteConfig;
