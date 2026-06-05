# Discord setup

CampTool uses Discord for two things:

1. **Login** — campers can sign in with their Discord account (OAuth2).
2. **Outreach** — sending DMs/reminders and verifying a camper is actually in
   your camp's Discord server (REST API, using a bot token).

This guide walks you through creating your own Discord application so you can
self-host CampTool with your own server. You need to be an **admin of your
camp's Discord server**. It takes about 10 minutes.

When you're done you'll have four values for your `.env`:

```
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
```

---

## 1. Create the application

1. Go to the **Discord Developer Portal**: https://discord.com/developers/applications
2. Click **New Application** (top right).
3. Name it (e.g. "MyCamp CampTool") and accept the terms. Create.
4. On the **General Information** page you can set an icon/description — optional.

## 2. Get the OAuth2 client credentials (for login)

1. In the left sidebar, open **OAuth2**.
2. Copy the **Client ID** → this is `DISCORD_CLIENT_ID`.
3. Click **Reset Secret** (or "Copy" if shown) to reveal the **Client Secret** →
   this is `DISCORD_CLIENT_SECRET`. Store it somewhere safe; Discord only shows
   it once.
4. Under **Redirects**, click **Add Redirect** and enter your callback URL:
   - Local dev: `http://localhost:3000/api/auth/callback/discord`
   - Production: `https://YOUR_DOMAIN/api/auth/callback/discord`
     (e.g. `https://tool.mathcamp.us/api/auth/callback/discord`)

   You can add multiple redirects — add both your dev and prod URLs. The path
   `/api/auth/callback/discord` is what better-auth expects; don't change it.
5. **Save Changes** at the bottom.

> The redirect URL must match exactly (scheme, host, port, path). If login fails
> with an "invalid redirect_uri" error, this is almost always the cause.

## 3. Create the bot (for DMs / membership checks)

1. In the left sidebar, open **Bot**.
2. Click **Add Bot** / **Reset Token** to reveal the **Bot Token** → this is
   `DISCORD_BOT_TOKEN`. Like the client secret, it's shown once — store it safely.
3. Under **Privileged Gateway Intents**, enable **Server Members Intent**. This
   lets CampTool verify whether a user is a member of your server. (We don't run
   a live gateway connection, but this intent is still required for the REST
   member-lookup endpoint to return data.)
4. Save.

## 4. Invite the bot to your server

The bot must be a member of your camp's server to read membership and send
messages.

1. Back in **OAuth2**, scroll to **OAuth2 URL Generator**.
2. Under **Scopes**, check **`bot`**.
3. Under **Bot Permissions**, check at minimum:
   - **View Channels**
   - **Send Messages**
   (DMs to users don't need a guild permission, but these cover announcements
   in a channel later.)
4. Copy the generated URL at the bottom, open it in your browser, pick your
   camp's server, and **Authorize**.

## 5. Get your server (guild) ID

1. In the Discord *app* (not the dev portal), enable Developer Mode:
   **User Settings → Advanced → Developer Mode** (toggle on).
2. Right-click your camp's server icon → **Copy Server ID** → this is
   `DISCORD_GUILD_ID`.

## 6. Fill in `.env`

```
DISCORD_CLIENT_ID=123456789012345678
DISCORD_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DISCORD_BOT_TOKEN=yyyyyyyy.yyyyyy.yyyyyyyyyyyyyyyyyyyyyyyyyyy
DISCORD_GUILD_ID=123456789012345678
```

Restart the server. Discord login and outreach should now work.

---

## Notes & troubleshooting

- **Secrets are sensitive.** The client secret and bot token grant control of
  your app/bot. Never commit them; `.env` is gitignored. If one leaks, reset it
  in the portal.
- **"invalid redirect_uri"** on login → the redirect in step 2.4 doesn't exactly
  match your `PUBLIC_BASE_URL` + `/api/auth/callback/discord`.
- **Membership check always returns "not a member"** → the bot isn't in the
  server (step 4) or **Server Members Intent** is off (step 3.3).
- **Can't DM a user** → the user must share a server with the bot (they do, if
  they're in your camp's server) and not have DMs from server members disabled.
- CampTool intentionally does **not** run a persistent gateway bot. All Discord
  actions are REST calls or OAuth redirects, so the deployment stays a single
  web server. See `plans/camptool.md` for the rationale.
