# CampTool as an installable app (PWA)

## Goal

Let people put CampTool on their phone's home screen and open it like an app:
no browser bars, its own icon and name, and a friendly page instead of the
browser's error when the playa has no signal. Cameron, 2026-11-21: "yes,
camptool should be able to be a PWA, right?"

## Environment / context

- Live at `https://camptool.org` (Cloudflare Worker), each camp at
  `<slug>.camptool.org`. Signing in, invites and apply pages live on the bare
  domain only (`app/lib/camp-host.ts`). The Bun path (`server.ts`) serves the
  same build for self-hosters.
- Static files: `public/` → `build/client/` → Workers static assets (or
  `server.ts`'s `serveAsset`). `public/_headers` sets `/assets/*` immutable.
- Before this: no favicon, no manifest, no service worker at all. The
  camp-theme contract (`packages/theme-contract`) carries map structures only,
  no branding. `camp.logo` exists (public apply page only).
- The sibling bins tracker (`../bins`, `i.mathcamp.us`) is an offline-first
  PWA; no code is shared with it.

## Decisions already made (don't re-ask)

- Do it (Cameron, above). "Best, not fastest" applies.
- Installed name follows the host: a camp's subdomain installs as that camp
  (its name), the bare domain as "CampTool". Each origin is its own install.

## Plan / steps

1. Icon: one SVG mark, plus PNGs rendered from it (192, 512, 512
   maskable, 180 Apple touch icon), committed under `public/`. A camp-specific
   icon can come later (camp-theme or `camp.logo`).
2. Manifest: a resource route `/manifest.webmanifest` built per request
   (camp name on a camp host). `display: standalone`, `start_url: /`,
   `scope: /`, theme and background colors matching Mantine's light body.
3. Head tags in `app/root.tsx`: manifest link, icons, `theme-color` for light
   and dark, `apple-mobile-web-app-*` and `mobile-web-app-capable`.
4. Service worker `public/sw.js`, deliberately small (navigation preload
   on, so it never delays a page load):
   - Page loads go to the network; if the network fails, the worker
     answers with a built-in "No connection" page (no cache needed) that
     reloads on the "online" event and by checking every 5 s.
   - Everything else passes straight through (page data, posts, uploads).
     Code files already stay in the browser's cache for a year
     (`public/_headers`), so the worker doesn't need to keep them.
   - No signed-in content is cached by the worker, so signing out or a
     shared phone leaks nothing.
   Registered from the client after load; a new deploy's worker takes over
   on the next visit.
5. [current] Verify, deploy, then Cameron installs it on his phone.

## Findings / gotchas

- An offline page cached at `/offline.html` would break on Cloudflare:
  Workers static assets redirect `/offline.html` → `/offline`, and a
  redirected response can't answer a page load. The worker builds the page
  itself instead.
- Chrome's offline emulation doesn't fire the page's `online` event, hence
  the 5 s check as well.

- iOS keeps a home-screen app's cookies separate from Safari's. A magic link
  opened from email signs in Safari, not the installed app. Passkeys and
  password sign-in inside the app work. Worth a line of help text if people
  trip on it (plans/passkey-first-auth.md is the longer-term answer).
- Camp subdomain installs send sign-in to the bare domain, which is outside
  the app's scope. To check on a real phone: that sign-in completes and comes
  back into the installed app.

## Progress log

- [x] 2026-11-21: steps 1–4. Verified headless on a local production build:
      Chrome reports no installability or manifest errors, the worker
      controls the page, going offline shows "No connection", and it
      returns to the page by itself once back online. On a camp subdomain
      the manifest says "Math Camp @ Group W" / "Math Camp" to a member and
      "CampTool" to anyone else.
- [ ] Step 5: deployed and checked live.
- [ ] Cameron installs it on his phone and checks sign-in from a camp
      subdomain install.

## Open questions for the user

1. The icon: a simple tent mark for now. Swap for real artwork whenever.

## Things not to do

- Don't cache pages or page data in the service worker: it would show one
  person's camp data after sign-out, and stale data with no way to tell.
- Don't precache the whole app in the worker; the HTTP cache plus the
  background preload (plans/fast-navigation.md step 8f) already cover it.
