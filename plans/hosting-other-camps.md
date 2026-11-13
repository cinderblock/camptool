# Hosting CampTool for other camps (multi-camp, multi-host)

> Task plan. Parent plan: `plans/camptool.md`. Plan path:
> `plans/hosting-other-camps.md`. Work happens on branch `multi-host` in the
> worktree `C:\Users\camer\git\Personal Projects\CampTool-multi-host`.

## Goal

Run one open, multi-camp CampTool instance that other camps can join (first a
friend's camp), hosted on **Cloudflare** for about $5/month, without tying the
app to Cloudflare: the same code keeps running on Bun + SQLite (firefly,
jackson, any Docker host). Donations later; **no billing code**.

## Environment / context (2026-11-13)

- Live today: `camptool.mathcamp.us` on **firefly** (DigitalOcean, 8 GB,
  $48/mo). Image built on a GitHub-hosted runner, pushed to
  `ghcr.io/cinderblock/camptool`; ops `pin.json` picks the digest.
  `CAMP_THEME` is an ops-owned build variable, asserted by an image label.
- **jackson** (32 GB, $72/mo, LA) runs only Discourse. Fallback host.
- The app is already multi-camp in one deploy: every tenant table carries
  `camp_id`; per-camp roles admin/officer/member/recruit; instance **super
  admins** plus signup and camp-creation lockdowns (`db/schema/instance.ts`).
- Host coupling found: `bun:sqlite` only in `db/client.server.ts`;
  `Bun.file`/`Bun.write` in `images.server.ts`, `sap.server.ts`,
  `backup.server.ts`; raw SQLite handle in `merge.server.ts` (3 sync
  transactions) and `backup.server.ts` (`serialize()`); `db.transaction` twice in
  `faq.server.ts`; `server.ts` (`Bun.serve` on a unix socket). `node:crypto` and
  `node:zlib` run on Workers with `nodejs_compat`.
- No email is sent by the app today, so nothing to split there.
- Discord: login OAuth (`DISCORD_CLIENT_*`) and the bot token are naturally
  per-host (one bot app can join many guilds). Only `DISCORD_GUILD_ID` is
  camp-specific.

## Decisions already made (don't re-ask)

1. **Shared, multi-camp, open instance.** Camp admins run their camp; the
   hoster is super admin. (Cameron, 2026-11-13.)
2. **Cloudflare first, jackson as fallback.** $5/mo Workers Paid. (Cameron.)
3. **Stay portable across hosts.** Host-specific code sits behind small
   adapters; Bun + SQLite stays a first-class target. (Cameron.)
4. **Branding is per camp.** A host may also ship server-wide structure packs.
   (Cameron.)
5. **No billing code.** Donations via an outside service. (Cameron.)
6. **Cameron is buying the domain.** Nothing waits on it until deploy.
7. **On Cloudflare: Workers + D1 + R2**, not Durable Objects. Reasons: D1 has
   Time Travel (point-in-time restore), a SQL console and `wrangler d1 export`;
   our only multi-statement atomic writes can be expressed as batches.
   (Claude, 2026-11-13; revisit only if latency proves bad.)
8. **Season rollover is soft.** No hard cutoff or forced lock; the "current
   event year" just moves on once an event is over. (Cameron.)
9. **Other events (UnSCruz etc.) wait.** General offering eventually; their
   maps are irregular. Tracked in `plans/season-2027.md`, not here.

## Design

### Structure packs (per-camp theme)

- Every camp-theme package named at build time is bundled (`CAMP_THEMES`,
  comma list). Its structures join one global registry, so any camp's saved
  objects always render. Kind values must be unique across packs (checked).
- Which packs a camp may **use** (palette, add actions) is data:
  - packs in the legacy `CAMP_THEME` variable are **server-wide** (every camp),
    which keeps today's single-camp Math Camp deploy unchanged;
  - otherwise a super admin enables a pack per camp.
- Unavailable kinds behave like an edition's banned kinds: hidden from
  palettes, rejected by add actions.

### Discord per camp

- `camp.discord_guild_id`, set by a camp admin. `DISCORD_GUILD_ID` env stays as
  the fallback for single-camp deploys.

### Host adapters

Selected by package.json `imports` conditions, so each bundle carries only its
own host code (`workerd` condition on Cloudflare, `default` elsewhere):

- `#host/db`: the Drizzle database (bun:sqlite or D1), typed **async** so code
  can't rely on sync results; `atomic([...])` for multi-statement writes
  (transaction on Bun, `batch` on D1).
- `#host/blobs`: put/get/delete/list for uploads (disk or R2).
- `#host/snapshot`: whole-database backup bytes (SQLite file on Bun, SQL dump on
  D1).
- Entry points: `server.ts` (Bun) and `workers/app.ts` (Cloudflare), both thin.

### D1 migrations

- Apply with `wrangler d1 migrations apply` from a generated folder where
  drizzle's `PRAGMA foreign_keys=OFF/ON` become `PRAGMA defer_foreign_keys`.
- **Hazard:** on D1, foreign keys can't be switched off, and deferring them does
  **not** stop `ON DELETE CASCADE`. A drizzle table rebuild (`__new_x`, drop,
  rename) of a table other tables cascade from would delete their rows. Safe
  for the existing migrations on an empty database; dangerous for any future
  one. `db:verify` will refuse such a migration after the D1 baseline, so it
  gets hand-written in a D1-safe form.

## Plan / steps

1. [ ] Season rollover: `CURRENT_EVENT_YEAR` moves on after the event ends.
2. [ ] Structure packs per camp (registry, enablement, palette filtering,
   super-admin UI, build var).
3. [ ] Discord guild per camp.
4. [ ] Host adapters: async db type, `atomic`, rewrite `merge.server.ts` and
   `faq.server.ts` transactions; blobs; snapshot; Bun entry unchanged.
5. [ ] Cloudflare target: `wrangler.jsonc`, Workers entry, Vite plugin under
   a build flag, D1 migration folder + safety check, local `wrangler dev`
   smoke test (no account needed).
6. [ ] Self-host docs: the Docker walkthrough and the Cloudflare walkthrough /
   deploy button.
7. [ ] Deploy to Cameron's Cloudflare account: **needs his yes for each
   change** (account, D1, R2, domain, secrets).

## Findings / gotchas

- D1 rejects `PRAGMA foreign_keys`, and deferral doesn't stop cascades (see
  Design). Sources: Cloudflare D1 foreign-keys docs; brachkow.com note
  (May 2026).

## Progress log

- [x] 2026-11-13: surveyed coupling, costed Cloudflare (Workers Paid $5/mo;
  D1 includes 25B row reads, 50M writes, 5 GB).

## Open questions for the user

1. Domain: whenever it's bought. Needed only at step 7.

## Things not to do

- Don't touch Cloudflare, DNS, Caddy or either server without Cameron's yes for
  that specific change. Stage it and show it.
- Don't put a second camp on a build whose packs aren't per camp.
- Don't merge or rebase the shared `master` checkout while another thread has
  uncommitted work there.
