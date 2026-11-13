/**
 * Per-camp Discord server helpers (plans/hosting-other-camps.md). The bot and
 * the login app belong to the deployment; one bot joins many servers, so only
 * the server is per camp. Pure: no database.
 */

/** A Discord snowflake: 17–20 digits. */
export function parseGuildId(raw: string): string | null {
  const v = raw.trim();
  return /^\d{17,20}$/.test(v) ? v : null;
}

/**
 * The Discord server a camp uses: its own setting, else the deployment-wide
 * `DISCORD_GUILD_ID` (a single-camp deployment's way of configuring it).
 */
export function campGuildId(camp: {
  discordGuildId: string | null;
}): string | null {
  return camp.discordGuildId || process.env.DISCORD_GUILD_ID || null;
}

/**
 * Link that adds this deployment's bot to a server. No permissions: looking up
 * whether someone is a member only needs the bot to be in the server. Null when
 * the deployment has no Discord app.
 */
export function botInviteUrl(): string | null {
  const id = process.env.DISCORD_CLIENT_ID;
  if (!id) return null;
  const u = new URL("https://discord.com/oauth2/authorize");
  u.searchParams.set("client_id", id);
  u.searchParams.set("scope", "bot");
  u.searchParams.set("permissions", "0");
  return u.toString();
}
