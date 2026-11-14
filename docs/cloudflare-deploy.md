# Deploying CampTool on Cloudflare

CampTool runs on Cloudflare Workers with **D1** (the database) and **R2**
(uploaded pictures and pass PDFs). It's the same app as the Bun/Docker build;
`#host/db` and `#host/blobs` in `package.json` pick the Cloudflare
implementations when the build targets Workers (see
`plans/hosting-other-camps.md`).

## What it costs

The **Workers Paid** plan, $5/month per Cloudflare account. It includes far
more than a handful of camps use: D1 includes 25 billion row reads, 50 million
row writes and 5 GB a month; R2 includes 10 GB free. The Free plan's 10 ms CPU
limit per request is too tight for this app's server rendering, so plan on
Paid.

## Try it locally (no account)

```sh
bun install
bun run cf:preview
```

That builds the Worker, creates a local D1 database under `.wrangler/`,
applies the migrations, and serves it at http://localhost:17940 (set
`PUBLIC_BASE_URL` in `.env` to match whatever port you use). Use
`bun run cf:dev` for the hot-reloading dev server instead.

## Deploy

1. `bunx wrangler login`
2. Set the public address in `wrangler.jsonc` → `vars.PUBLIC_BASE_URL`
   (e.g. `https://camptool.example.org`).
3. Secrets:

   ```sh
   bunx wrangler secret put BETTER_AUTH_SECRET   # any long random string
   ```

   Optional, for Discord login and member checks: `DISCORD_CLIENT_ID`,
   `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` (see `discord-setup.md`).
4. `bun run cf:deploy`. The first deploy creates the D1 database (`camptool`)
   and the R2 bucket (`camptool-uploads`), applies the migrations, and
   publishes the Worker.
5. Point your domain at the Worker (Workers → camptool → Settings → Domains &
   Routes).

### A subdomain for each camp

Set `vars.CAMP_SUBDOMAINS` to `"1"` in `wrangler.jsonc`, with
`PUBLIC_BASE_URL` at the bare domain (`https://camptool.example.org`). Each camp
then lives at `<slug>.camptool.example.org`. Cloudflare needs a proxied
wildcard DNS record (`*`) and a Worker route for `*.camptool.example.org/*`;
Universal SSL already covers one level of wildcard.

Signing in, passkey sign-in, the Discord callback, invites and public apply
pages all stay on the bare domain; the session cookie is set for the whole
domain, so one sign-in covers every camp. A camp's slug has to be a valid
DNS label, and names like `www`, `api` and `admin` are reserved
(`app/lib/camp-host.ts`).

The first account to sign up becomes the site's super admin.

### Moving a camp from its own deploy

A camp already running on its own Bun server (say `camptool.example.com`) can
move onto the shared site without anyone signing up again:

1. On the old site, Site admin → Backup. Keep the old site's
   `BETTER_AUTH_SECRET`: set the same value on the new one, so its session
   cookies still verify.
2. Import into the new site's (still empty) D1 database and R2 bucket:

   ```sh
   bun scripts/import-to-d1.ts camptool-backup-YYYY-MM-DD.tar.gz \
     --legacy-rp-id camptool.example.com \
     --packs <slug>=<theme package> --discord-guild <slug>=<server id> \
     --apply remote
   ```

   `--packs` and `--discord-guild` carry over what the old deploy had in env
   (`CAMP_THEME`, `DISCORD_GUILD_ID`); the new site must bundle the pack in
   `CAMP_THEMES`. Passwords, Discord links and sessions come across as they
   are. The script refuses a D1 database that already has users.
3. Set `vars.LEGACY_HOSTS` to `camptool.example.com=<slug>`, point the old
   name's DNS at the Worker (proxied) and add a route
   `camptool.example.com/*`.

From then on, every page on the old address redirects to the same page at
`<slug>.camptool.example.org`. A browser still signed in there arrives signed
in. Passkeys can't move (each belongs to the address it was made for), so the
old address keeps one page, `/moved`, where someone can use their old passkey
once to be signed in at the new address; the app then has them make a new
passkey before anything else. The login page links there for anyone who needs
it. `e2e/camp-move.ts` and `e2e/camp-move-browser.ts` rehearse the whole move
locally.

## Updating

`bun run cf:deploy` again. Migrations are applied **before** the new Worker
goes live, so a migration has to work with the code that's still running for
those few seconds. Adding columns and tables does; renaming or dropping
doesn't.

## Migrations and D1

D1 can't turn foreign keys off, and deferring them doesn't stop `ON DELETE
CASCADE`. A migration that rebuilds a table other tables cascade from would
silently delete their rows. `bun run db:verify` refuses such a migration; write
it by hand instead. `scripts/d1-migrations.ts` explains the details, and
`db/migrations-d1/` holds the few old migrations rewritten for D1's limits.

## Backups

Site admin → Backup downloads a `.tar.gz` with `camptool.sql` (the whole
database as SQL) and `uploads/` (every R2 file under its key). Cloudflare also
keeps 30 days of D1 point-in-time history ("Time Travel"): `wrangler d1
time-travel restore camptool --timestamp=…`.

The SQL restores onto either host, so a deployment can move:

- **Onto a Bun host:** `sqlite3 /srv/camptool/data/camptool.db < camptool.sql`
  and copy `uploads/` to `/srv/camptool/data/uploads/`. The dump carries the
  Bun migrator's record, so the app boots on it without re-migrating.
- **Into a fresh D1:** `wrangler d1 execute camptool --remote --file
  camptool.sql`, then upload each `uploads/<key>` to the bucket at `<key>`.
