/**
 * Discord integration — REST only, no gateway process (see plans/camptool.md).
 *
 * The OAuth credential lives in better-auth's `account` table. We denormalize
 * the Discord identity into our per-camp `discord_link` table so the directory
 * can show it and outreach can DM without re-reading OAuth state. Guild
 * verification is a REST call gated on a bot token being configured.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.server";
import { account, discordLink, membership, user } from "../../db/schema";

export type DiscordLinkView = {
  discordUserId: string;
  discordUsername: string | null;
  inGuild: boolean;
};

/**
 * Reconcile discord_link rows for a camp from the source-of-truth `account`
 * table. Idempotent. Returns a map of userId -> linked Discord identity for the
 * members currently in the camp.
 */
export async function syncDiscordLinksForCamp(
  campId: string,
): Promise<Map<string, DiscordLinkView>> {
  // Members of this camp who have a linked Discord account.
  const linked = await db
    .select({
      userId: membership.userId,
      discordUserId: account.accountId,
      displayName: user.name,
    })
    .from(membership)
    .innerJoin(
      account,
      and(
        eq(account.userId, membership.userId),
        eq(account.providerId, "discord"),
      ),
    )
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.organizationId, campId));

  for (const row of linked) {
    await db
      .insert(discordLink)
      .values({
        id: crypto.randomUUID(),
        campId,
        userId: row.userId,
        discordUserId: row.discordUserId,
        discordUsername: row.displayName,
      })
      .onConflictDoUpdate({
        target: [discordLink.campId, discordLink.userId],
        set: {
          discordUserId: row.discordUserId,
          discordUsername: row.displayName,
          updatedAt: new Date(),
        },
      });
  }

  return getDiscordLinksForCamp(campId);
}

export async function getDiscordLinksForCamp(
  campId: string,
): Promise<Map<string, DiscordLinkView>> {
  const rows = await db
    .select()
    .from(discordLink)
    .where(eq(discordLink.campId, campId));
  return new Map(
    rows.map((r) => [
      r.userId,
      {
        discordUserId: r.discordUserId,
        discordUsername: r.discordUsername,
        inGuild: r.inGuild,
      },
    ]),
  );
}

/**
 * Check whether a Discord user is in the configured guild, via the REST API.
 * Returns null when Discord isn't configured (bot token / guild id missing), so
 * callers can render "unknown" rather than "not a member".
 */
export async function checkGuildMembership(
  discordUserId: string,
): Promise<boolean | null> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) return null;

  const res = await fetch(
    `https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}`,
    { headers: { Authorization: `Bot ${token}` } },
  );
  if (res.status === 404) return false;
  if (!res.ok) return null;
  return true;
}

export async function markGuildStatus(
  campId: string,
  userId: string,
  inGuild: boolean,
): Promise<void> {
  await db
    .update(discordLink)
    .set({ inGuild, verifiedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(discordLink.campId, campId), eq(discordLink.userId, userId)));
}
