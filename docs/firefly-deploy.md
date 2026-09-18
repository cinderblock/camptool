# Deploying CampTool

CampTool serves over a **unix socket** (no TCP port) so a reverse proxy can
terminate TLS in front of it. `bun run start` boots `server.ts`, which binds the
React Router handler to `$SOCKET_PATH` (default `/run/camptool/camptool.sock`).
There are two deployment paths.

## firefly (the canonical deployment)

CampTool runs on the **firefly** host and is served at
**https://camptool.mathcamp.us/**. DNS, TLS (Cloudflare proxied, Full strict),
the reverse proxy, the runtime composition and **which build is running** are all
owned by the **ops repo** (`cinderblock/ops`). This repo builds an image and
stops.

**Pushing to `master` does not deploy.** The two halves:

- **This repo:** `.github/workflows/build.yml` runs on a GitHub-hosted runner —
  `bun install`, typecheck, `db:verify`, `docker build`, push
  `ghcr.io/cinderblock/camptool:<sha>` and `:latest`. The image is labelled with
  the commit (`org.opencontainers.image.revision`) and with the camp theme it was
  built against (`us.mathcamp.camptool.theme`). The job summary prints a
  ready-to-paste `pin.json`.
- **ops:** `servers/firefly/stacks/camptool/` holds `compose.yml` (how it runs),
  `env.json` (which secrets it gets) and `pin.json` — the image **digest** that
  runs, plus the commit and theme the deploy verifies the image against before
  starting it. Editing `pin.json` and pushing ops is a deploy; reverting it is a
  rollback.

This repo has no self-hosted runner and no access to firefly. It used to: the app
ran inside a runner container on the box and every push built, staged and
restarted it there — which is how three deploys in a row got OOM-killed on
2026-08-25 and took the live site down with them (see
`plans/wizard-step-homes.md`). The build moved off the box then; the deploy
followed when ops took ownership of versions.

### Build-time theme

`CAMP_THEME` (which camp-theme package Vite bakes into the bundle) is a
**build-time** input. This workflow deliberately names no camp — a fork builds
`@camptool/default-theme`. The value is the repo's `CAMP_THEME` Actions variable,
which **ops owns**: declared in ops at
`servers/firefly/stacks/camptool/build-vars.env` and pushed here by ops's
`sync-camptool-repo-vars` job. The Dockerfile turns it into an image label, and
ops's `pin.json` asserts that label at deploy time, so a variable that was never
synced fails loudly instead of shipping the wrong camp's branding.

### Runtime config

Everything the app reads at runtime comes from ops's `compose.yml` and
`env.json` — `PUBLIC_BASE_URL`, `DATABASE_PATH`, `SOCKET_PATH`,
`BETTER_AUTH_SECRET` (generated once by ops and reused across deploys, so
sessions survive), the optional `DISCORD_*` set and `DEV_API_TOKEN`. There is
no env-file in this repo and none on the box outside ops's persistent state.

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
