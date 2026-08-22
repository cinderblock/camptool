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
  // The camp's public programming lineup (no auth; 404s unless fully on).
  route("c/:slug/schedule", "routes/c.$slug.schedule.tsx"),
  route("i/:token", "routes/i.$token.tsx"),
  // Redeem an officer-issued password reset link. Public: the whole point is
  // that the person can't sign in. Opening it is read-only — it reports the
  // link's status and nothing more (plans/password-recovery.md).
  route("reset/:token", "routes/reset.$token.tsx"),
  route("impersonate", "routes/impersonate.tsx"),
  // Privacy-mode toggle (admin-only; sets the per-browser cookie).
  route("privacy", "routes/privacy.tsx"),
  // Snooze the passkey banner for 24h (resource route; sets a cookie).
  route("passkey-nag", "routes/passkey-nag.tsx"),
  route("start", "routes/start.tsx"),
  // Super-admin DB backup download (resource route; self-gated).
  route("export-db", "routes/export-db.tsx"),
  // Hand-off into the camp's bins inventory app, signed in (resource route;
  // self-gated). Outside the shell because it only ever redirects.
  route("bins", "routes/bins.tsx"),
  // Uploaded pictures (plans/pictures-in-bodies.md). Resource routes, outside
  // the shell: they stream bytes, not markup. Auth-gated and camp-scoped —
  // pictures are camp data, so there is no public/static image path.
  route("media/:id", "routes/media.$id.tsx"),
  route("media/:id/full", "routes/media.$id.full.tsx"),
  route("api/media", "routes/api.media.tsx"),
  // Setup Access Pass downloads (plans/sap-import-and-distribution.md).
  // Resource routes, outside the shell: they stream a PDF, not markup. Both
  // are gated on the pass being RELEASED and the viewer being entitled to it —
  // an assigned-but-unreleased pass is downloadable by nobody.
  route("sap/pass/:stockId", "routes/sap.pass.$stockId.tsx"),
  route("sap/group", "routes/sap.group.tsx"),
  route("api/auth/*", "routes/api.auth.$.tsx"),
  // Begin a passkey-first (password-less) signup; returns the opaque handle
  // that addPasskey({ context }) carries back to the server.
  route("api/passkey-signup", "routes/api.passkey-signup.tsx"),
  // Begin enrolling a passkey onto an EXISTING account from an officer-issued
  // recovery link (plans/password-recovery.md). Same handle mechanism as
  // passkey-signup, but it attaches to an account that already exists.
  route("api/passkey-recovery", "routes/api.passkey-recovery.tsx"),
  // TEMPORARY passkey-first spike harness. Remove with routes/spike.passkey.tsx
  // once the flow lands in AuthInline (plans/passkey-first-auth.md step 5).
  route("spike/passkey", "routes/spike.passkey.tsx"),
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
    route("schedule", "routes/dashboard/schedule.tsx"),
    route(
      "schedule/:gatheringId",
      "routes/dashboard/schedule.$gatheringId.tsx",
    ),
    route("programming", "routes/dashboard/programming.tsx"),
    route("programming/board", "routes/dashboard/programming.board.tsx"),
    route(
      "programming/:offeringId",
      "routes/dashboard/programming.$offeringId.tsx",
    ),
    route("map", "routes/dashboard/map.tsx"),
    route("bringing", "routes/dashboard/bringing.tsx"),
    route("inventory", "routes/dashboard/inventory.tsx"),
    route("supplies", "routes/dashboard/supplies.tsx"),
    route("documents", "routes/dashboard/documents.tsx"),
    route("wiki", "routes/dashboard/wiki.tsx"),
    route("wiki/:slug", "routes/dashboard/wiki.$slug.tsx"),
    route("wiki/:slug/edit", "routes/dashboard/wiki.$slug.edit.tsx"),
    route("faq", "routes/dashboard/faq.tsx"),
    // A single answer, standalone — what a `[[/faq/…]]` deep link resolves to.
    route("faq/:slug", "routes/dashboard/faq.$slug.tsx"),
    route("tickets", "routes/dashboard/tickets.tsx"),
    route("passes", "routes/dashboard/passes.tsx"),
    route("swaps", "routes/dashboard/swaps.tsx"),
    route("fuel", "routes/dashboard/fuel.tsx"),
    route("finances", "routes/dashboard/finances.tsx"),
    route("dues", "routes/dashboard/dues.tsx"),
    route("recruits", "routes/dashboard/recruits.tsx"),
    // Officer-only CRM. The list, then one person's whole conversation.
    route("prospects", "routes/dashboard/prospects.tsx"),
    route(
      "prospects/:prospectId",
      "routes/dashboard/prospects.$prospectId.tsx",
    ),
    route("training", "routes/dashboard/training.tsx"),
    route("questions", "routes/dashboard/questions.tsx"),
    // Officer-only: what everyone answered, and its spreadsheet export.
    route("questions/responses", "routes/dashboard/questions.responses.tsx"),
    route(
      "questions/responses.csv",
      "routes/dashboard/questions.responses.csv.tsx",
    ),
    route("onboarding", "routes/dashboard/onboarding.tsx"),
    route("account", "routes/dashboard/account.tsx"),
    route("settings", "routes/dashboard/settings.tsx"),
    route("admin", "routes/dashboard/admin.tsx"),
  ]),
] satisfies RouteConfig;
