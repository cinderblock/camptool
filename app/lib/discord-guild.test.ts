import { afterEach, describe, expect, it } from "bun:test";
import { botInviteUrl, campGuildId, parseGuildId } from "./discord-guild";

const saved = { ...process.env };
afterEach(() => {
  process.env.DISCORD_GUILD_ID = saved.DISCORD_GUILD_ID;
  process.env.DISCORD_CLIENT_ID = saved.DISCORD_CLIENT_ID;
});

describe("parseGuildId", () => {
  it("accepts a snowflake, trimmed", () => {
    expect(parseGuildId(" 123456789012345678 ")).toBe("123456789012345678");
  });
  it("refuses anything else", () => {
    expect(parseGuildId("12345")).toBeNull();
    expect(parseGuildId("https://discord.gg/abc")).toBeNull();
  });
});

describe("campGuildId", () => {
  it("prefers the camp's own server", () => {
    process.env.DISCORD_GUILD_ID = "111111111111111111";
    expect(campGuildId({ discordGuildId: "222222222222222222" })).toBe(
      "222222222222222222",
    );
  });
  it("falls back to the deployment's server", () => {
    process.env.DISCORD_GUILD_ID = "111111111111111111";
    expect(campGuildId({ discordGuildId: null })).toBe("111111111111111111");
  });
  it("is null when neither is set", () => {
    process.env.DISCORD_GUILD_ID = "";
    expect(campGuildId({ discordGuildId: null })).toBeNull();
  });
});

describe("botInviteUrl", () => {
  it("asks for the bot scope and no permissions", () => {
    process.env.DISCORD_CLIENT_ID = "999";
    const u = new URL(botInviteUrl() ?? "");
    expect(u.searchParams.get("client_id")).toBe("999");
    expect(u.searchParams.get("scope")).toBe("bot");
    expect(u.searchParams.get("permissions")).toBe("0");
  });
  it("is null without a Discord app", () => {
    process.env.DISCORD_CLIENT_ID = "";
    expect(botInviteUrl()).toBeNull();
  });
});
