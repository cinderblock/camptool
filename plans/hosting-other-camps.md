# Hosting CampTool for other camps

> Task plan. Parent plan: `plans/camptool.md`. Plan path:
> `plans/hosting-other-camps.md`

## Goal

Host CampTool for a friend's camp, and decide how other camps get it: shared
hosting run by Cameron (paid for by donations), a one-button self-host, a
walkthrough, or a mix.

## Environment / context (2026-11-13)

- Live: `camptool.mathcamp.us` on **firefly** (DigitalOcean, 4 cores, 8 GB,
  $48/mo, shared with other ops stacks). Image built on a GitHub-hosted runner,
  pushed to `ghcr.io/cinderblock/camptool`; ops `pin.json` picks the digest.
- **jackson** (vpshostingservice.co, 5 cores, 32 GB, 480 GB, $72/mo, LA) runs
  only Discourse and a speed test. Plenty of spare room.
- The app is **already multi-camp in one deploy** (decision #1: every tenant
  table carries `camp_id`, users can belong to several camps, there is a super
  admin and signup/camp-creation lockdowns).
- Runtime: Bun (`bun:sqlite` in 29 files, `Bun.serve`, `Bun.*` file APIs in
  images/SAP/backup), SQLite file + uploaded pictures on local disk, migrations
  run on boot.

## Findings

### What blocks a second camp on the shared instance

1. **The camp theme is per build, not per camp.** `CAMP_THEME` is baked in by
   Vite (`vite.config.ts`, `app/theme`). A friend's camp on
   `camptool.mathcamp.us` would get Math Camp's custom structures and branding.
   Fix: bundle every theme package and pick one per camp at runtime (a
   `camp.theme` column). Themes contain React render functions, so they must
   be in the bundle; they can't be uploaded data.
2. **Instance-wide integrations.** Discord (`DISCORD_*` env) and email are
   configured once per deploy. A second camp needs its own Discord guild and
   possibly its own sender. Needs per-camp settings.
3. **Domain and name.** `mathcamp.us` is Math Camp's. A shared service wants a
   neutral domain, with camps at `/c/<slug>` (already the URL shape) or
   subdomains.
4. **Trust.** Cameron, as super admin, can see every camp's data. The friend
   should agree to that; a short privacy note covers it.

### Cloudflare-only hosting

Two ways, neither a config change:

- **Workers + D1 + R2 (a port).** React Router v7 and better-auth run on
  Workers; Drizzle has a D1 driver. The work: replace `bun:sqlite` with D1
  (async only, and **no interactive transactions**, so the five
  `.transaction()` calls become `batch()`), move uploads to R2, replace `Bun.*`
  file APIs, run migrations with `wrangler` instead of on boot, and check the
  PDF/QR libraries under workerd. On the Free plan, Workers get 10 ms CPU per
  request, which SSR of this app will likely exceed, so plan on Workers Paid.
- **Cloudflare Containers.** Runs the existing image, but container disk is
  ephemeral, so the SQLite file would be lost on every sleep or restart. Only
  viable with the database moved to D1 anyway, so it is no shortcut.

**Cost:** Workers Paid is **$5/month per account** and includes Containers
allowances, D1 (25 billion row reads and 50 million row writes a month, 5 GB),
and R2's free 10 GB. One account could host many small camps for $5/month. The
cost is engineering time, not money.

A Workers version is also what makes a real **one-button deploy** possible
("Deploy to Cloudflare" button: forks the repo, creates D1/R2, deploys). Today
the closest thing is `Dockerfile` + `compose.yaml`, which needs a Linux host
and a reverse proxy.

### Shared hosting on our own servers

Marginal cost for one more camp: about zero. The app is small and the database
is one SQLite file. firefly has had memory trouble (2026-08-25 OOMs, from
builds that no longer run there). jackson has 32 GB and little load, so a
separate shared instance there would also isolate other camps from Math
Camp's production. Any change on either box goes through the ops repo, with
Cameron's yes for each change.

## Recommendation

1. **Now, for the friend:** a camp on a shared instance, after fixing blockers
   1 to 3 (per-camp theme, per-camp Discord/email, neutral domain). This is
   also the start of "a hosting service camps donate to". Donations: GitHub
   Sponsors or Open Collective. No billing code in the app.
2. **Where:** a second instance on jackson under a neutral domain (keeps
   friends' camps away from Math Camp's prod and firefly's memory limits), or
   simply the existing instance. Open question 2.
3. **Later, its own project:** the Cloudflare (Workers + D1 + R2) port for
   one-button self-hosting, with the Docker walkthrough as the other option.
   Keep the code portable meanwhile (decision #2 already says so).

## Open questions for the user

1. Does the friend's camp need its own theme (custom structures, branding), or
   is the default theme fine to start? If default is fine, blocker 1 can wait.
2. Shared instance: the existing one, or a new one on jackson? Recommended:
   jackson.
3. Domain for the shared service? (Needs a name you own; DNS is an ops change.)
4. Is the Cloudflare port worth doing now, or after the friend is running?
   Recommended: after.

## Things not to do

- Don't touch Cloudflare, DNS, Caddy or either server without Cameron's yes
  for that specific change (global rule). Stage it in the ops repo and show it.
- Don't put the friend's camp on the Math Camp build until the theme is per
  camp, or they'll see Math Camp's structures.

## Progress log

- [x] 2026-11-13: costed Cloudflare, sized jackson and firefly, listed blockers.
