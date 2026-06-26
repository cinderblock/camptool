# Feedback form + client error logging

> Living plan. Path: `plans/feedback-and-error-logging.md`.

## Goal

(1) Forward client-side errors (uncaught, unhandled rejections, `console.error`)
to the server into their own table with metadata, so we can auto-trace what's
breaking for users. (2) A user **feedback** form (bug/issue/improvement/
suggestion/compliment/other) with a structured **bug template**
(doing/trying/expected/actual) and captured context (recent navigation/error
breadcrumbs, timestamps, URL, user agent, who/where).

## Design

Shared **client telemetry module** (`app/lib/telemetry.client.ts`):
- A capped ring buffer of **breadcrumbs**: route navigations + captured errors
  (and we can add fetch/mutation crumbs later). `getBreadcrumbs()` for the form.
- Installs once: `window.onerror`, `unhandledrejection`, and a `console.error`
  wrapper. Each pushes a breadcrumb AND POSTs to `/api/log-error`
  (`navigator.sendBeacon`, fallback `fetch`). Guarded against recursion + flood
  (dedupe identical messages, hard cap per page).
- A `useRecordNavigation()` hook in `root.tsx` pushes a crumb on location change.

Server:
- `client_error` table: message, stack, kind, source/line/col, url, userAgent,
  userId/campId (from session if present), breadcrumbs JSON, createdAt. Truncate
  big fields. Endpoint never throws back into the client.
- `feedback` table: kind, title, body, structured `details` JSON (bug template),
  url, metadata JSON (breadcrumbs/ua/viewport), userId/campId/editionId, status,
  createdAt.
- Both reviewable by **super admin** (Site admin page / a feedback admin view).

## Slices

1. [x] **A — Client error logging (LANDED).** `client_error` table (migration
   0032); `/api/log-error` resource route (best-effort, capped, never errors back);
   `telemetry.client.ts` (breadcrumb buffer + window error / unhandledrejection /
   console.error handlers, deduped + flood-capped) wired in `root.tsx`; recent-25
   errors list on Site admin.
2. [x] **B — Feedback form (LANDED).** `feedback` table (migration 0032);
   `FeedbackButton` in the app header → modal (type select; bug → doing/trying/
   expected/actual template; else a message); `/api/feedback` action captures
   breadcrumbs + url + viewport + user agent + session user/camp; feedback list on
   Site admin. Both done.

## Dev telemetry API (for tracing — LANDED)
Token-gated read APIs so a developer/agent can pull telemetry from the live
deployment (can't reach the firefly FS, so it's an HTTP API):
- `GET /api/dev/errors?token=…` — filters: `limit`, `since` (ms/ISO/"24h"/"7d"),
  `kind`, `q` (message substring), `group=1` (aggregate by message+source w/ counts).
  Returns full rows incl. stack + parsed breadcrumbs.
- `GET /api/dev/feedback?token=…` — `limit`, `since`, `kind`; full rows + metadata.
- Auth: `DEV_API_TOKEN` env var (constant-time compare); unset ⇒ endpoints 404.
  Pass `?token=` or `Authorization: Bearer …`. Ops must set the var (like CAMP_THEME).

## Notes / gotchas
- Don't let the error forwarder loop (a failed POST must not log an error).
- Cap payload sizes server-side; rate/flood guard.
- sendBeacon for reliability on unload; fetch keepalive fallback.
