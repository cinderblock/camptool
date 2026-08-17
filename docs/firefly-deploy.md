# Deploying CampTool

CampTool serves over a **unix socket** (no TCP port) so a reverse proxy can
terminate TLS in front of it. `bun run start` boots `server.ts`, which binds the
React Router handler to `$SOCKET_PATH` (default `/run/camptool/camptool.sock`).
There are two deployment paths.

## firefly (the canonical auto-deploy)

CampTool auto-deploys to the **firefly** host and is served at
**https://camptool.mathcamp.us/**. DNS, TLS (Cloudflare proxied, Full strict),
the reverse proxy, the runner container, and the app supervisor are all owned by
the **ops repo**. This repo only builds the app and stages a ready-to-run release
for the supervisor to launch.

How it works (frozen contract — see also the coordination notes in the ops repo):

- The app runs **inside** an isolated self-hosted-runner container on firefly
  (`firefly-camptool`, labels `firefly,self-hosted`, root). The container's PID1
  supervisor owns the app process; a GitHub Actions job can't own it directly
  because Actions kills the job's process tree when the job ends.
- On every push to `master`, `.github/workflows/deploy.yml` runs **on that
  runner** and:
  1. `bun install --frozen-lockfile` + `bun run build`,
  2. stages a self-contained tree (build output, `server.ts`, `run`, prod
     `node_modules`, and `db/migrations/`) to `/srv/camptool/releases/$GITHUB_SHA/`,
  3. atomically flips `/srv/camptool/current` → that release,
  4. `touch /srv/camptool/restart` — the supervisor watches this sentinel and
     restarts the app (CI never touches supervisord's control socket).
- The supervisor launches `/srv/camptool/current/run` with the release dir as
  cwd; `run` does `exec bun server.ts`. The app binds
  `/run/camptool/camptool.sock`, `chmod 0666`s it, and unlinks a stale socket on
  boot. Caddy shares that socket via a named volume and proxies the public URL to
  it. The SQLite DB lives at `/srv/camptool/data/camptool.db` (persistent volume,
  outside the per-SHA release dir) and migrations apply on boot.

Until the first successful deploy the site returns **502** — expected.

### Runtime config (ops-managed env-file)

CI writes **no** secrets. The ops stack injects an env-file into the app process
with these keys:

| Key | Required | Notes |
|---|---|---|
| `PUBLIC_BASE_URL` | yes | `https://camptool.mathcamp.us` — auth callbacks + links |
| `BETTER_AUTH_SECRET` | yes | 32+ random chars (`openssl rand -base64 32`) |
| `DATABASE_PATH` | yes | `/srv/camptool/data/camptool.db` (persistent, outside releases) |
| `UPLOADS_PATH` | no | picture files; defaults to `uploads/` beside `DATABASE_PATH` → `/srv/camptool/data/uploads` |
| `DISCORD_CLIENT_ID` / `_SECRET` | no | enables Discord login/link |
| `DISCORD_BOT_TOKEN` / `_GUILD_ID` | no | enables DM/guild features |
| `NODE_ENV` | no | `production` (conventional) |
| `CAMP_THEME` | no | **build-time** — camp-theme package to bake in (default = built-in). See below. |

`SOCKET_PATH` defaults to `/run/camptool/camptool.sock` — leave it unset.

## Backing it up

**`/export-db` is the complete backup.** One `.tar.gz` holding both halves of
the state: the database (a `serialize()` snapshot, WAL included, safe to take
while the app runs) and every uploaded picture at full resolution.

```
camptool-backup-YYYY-MM-DD.tar.gz
├── MANIFEST.txt     what's inside, plus anything already missing
├── camptool.db      the whole database, every camp
└── uploads/<camp-id>/…   every picture, full resolution
```

Restore — stop the app first, since it opens the database and migrates on boot:

```sh
tar -xzf camptool-backup-YYYY-MM-DD.tar.gz -C /srv/camptool/data
```

The entries are deliberately named `camptool.db` and `uploads/…`, with no
wrapping directory, so extracting into `/srv/camptool/data` puts everything
back exactly where it came from.

`MANIFEST.txt` also reports integrity: picture rows whose file had already been
lost (a backup can't recover those, and you should know), and files with no row
(included regardless — a backup preserves what exists).

The `uploads` tree is append-mostly and grows with the camp's photos; nothing
prunes it automatically, so the archive grows too.

**`CAMP_THEME` is build-time — the one env-file key consumed at build, not
runtime.** It selects the camp-theme package Vite compiles into the bundle
(custom map structures, etc.). It lives in this same ops env-file (the deploy job
inherits it, like `BETTER_AUTH_SECRET`), so the build picks it up. The repo is
camp-agnostic: nothing is hardcoded, and unset → the built-in
`@camptool/default-theme`. Math Camp's deployment sets
`CAMP_THEME=@camptool/mathcamp-theme`. Caveat: because it's read at build,
**changing it takes effect on the next deploy, not a plain restart** (the other
keys here are read at process launch). Generic self-host (non-firefly) passes it
as a Docker build-arg instead (see below).

### Health

The uptime monitor checks `GET https://camptool.mathcamp.us/` and expects `200`;
the public landing (`/`) serves it. The deploy job also self-checks `200`
directly on the socket before finishing.

## Generic self-host (any host with a reverse proxy)

For self-hosting outside firefly, a `Dockerfile` + `compose.yaml` are included.
They build the same `server.ts` socket server into an `oven/bun` image, bind-mount
`/run/camptool` for the socket, and read runtime config from
`/etc/camptool/camptool.env` (same keys as the table above). Point your own
reverse proxy at `/run/camptool/camptool.sock`:

```bash
sudo mkdir -p /etc/camptool
sudo install -m 600 /dev/stdin /etc/camptool/camptool.env <<'EOF'
PUBLIC_BASE_URL=https://camp.example.org
BETTER_AUTH_SECRET=__REPLACE_ME__
EOF
docker compose up -d --build
```

If you ship a custom camp-theme package, set `CAMP_THEME` (build-time) before
building: `CAMP_THEME=@camptool/mycamp-theme docker compose up -d --build`.
