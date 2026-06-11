# Deploying CampTool to firefly

CampTool auto-deploys to the **firefly** host (`firefly.isozilla.com`) and is
served at **https://camptool.mathcamp.us/**. DNS + TLS (Cloudflare proxied, Full
strict) and the reverse proxy are managed by the ops repo — this repo only
builds the app and makes it listen on a unix socket.

## How it works

- A self-hosted GitHub Actions runner (`firefly-camptool`, labels
  `firefly,self-hosted`) is provisioned on the repo by the ops repo. It runs as
  **root** on the host.
- On every push to `master`, `.github/workflows/deploy.yml` runs **on that
  runner** and does `docker compose up -d --build`.
- The app runs as a Docker container (`camptool`) that binds a unix socket at
  **`/run/camptool/camptool.sock`** (see `server.ts` — no TCP port is opened).
- The ops-managed Caddy reverse-proxies `https://camptool.mathcamp.us/` → that
  socket. `/run/camptool` is bind-mounted into both the Caddy container and this
  app's container, so the socket the app creates is the one Caddy connects to.
- The SQLite database lives in the `camptool-data` Docker volume
  (`/data/camptool.db` inside the container) and survives redeploys. Migrations
  apply automatically on container start.

Until the first successful deploy the site returns **502** — that's expected,
not a misconfiguration.

## One-time host setup (ops owner)

The deploy reads secrets + deployment config from a root-owned env file on the
host. **It is not in git.** Create it once:

```bash
sudo mkdir -p /etc/camptool
sudo install -m 600 /dev/stdin /etc/camptool/camptool.env <<'EOF'
# Public-facing base URL — drives auth callbacks and absolute links.
PUBLIC_BASE_URL=https://camptool.mathcamp.us

# Long random secret. Generate with: openssl rand -base64 32
BETTER_AUTH_SECRET=__REPLACE_ME__

# Optional Discord integration (leave blank to disable).
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
EOF
```

`DATABASE_PATH`, `SOCKET_PATH`, and `NODE_ENV` are set by `compose.yaml`; don't
put them in the env file.

## Health

The ops uptime monitor checks `GET https://camptool.mathcamp.us/` and expects
`200`. The app's public landing page (`/`) serves that. The deploy workflow also
self-checks `200` directly on the socket before finishing.

## Manual operations on the host

```bash
cd /root/actions-runner-camptool/_work/camptool/camptool   # latest checkout
docker compose logs -f camptool        # tail logs
docker compose restart camptool        # restart without rebuilding
docker compose up -d --build           # rebuild + restart (what CI runs)
```
