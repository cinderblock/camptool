import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink, organization } from "better-auth/plugins";
import { db, schema } from "../../db/client.server";
import { ac, roles } from "./permissions";

const baseURL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

// Discord is optional: email/password + magic link + passkeys all work without
// it. When these two env vars are present, Discord login lights up automatically.
const discordConfigured = Boolean(
  process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET,
);

export const auth = betterAuth({
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [baseURL],

  database: drizzleAdapter(db, { provider: "sqlite", schema }),

  emailAndPassword: { enabled: true },

  socialProviders: discordConfigured
    ? {
        discord: {
          clientId: process.env.DISCORD_CLIENT_ID as string,
          clientSecret: process.env.DISCORD_CLIENT_SECRET as string,
        },
      }
    : {},

  plugins: [
    organization({
      ac,
      roles,
      // Our role set has no "owner"; the camp creator becomes an admin.
      creatorRole: "admin",
      schema: {
        organization: { modelName: "camp" },
        member: {
          modelName: "membership",
          additionalFields: {
            playaName: { type: "string", required: false, input: true },
            status: { type: "string", required: false, input: true },
            // Server-set, not client-writable.
            joinedAt: { type: "date", required: false, input: false },
          },
        },
      },
    }),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        // No mail transport wired yet — log the link so local dev works
        // end-to-end. Phase 4 swaps this for real email/Discord delivery.
        console.log(`[magic-link] ${email} -> ${url}`);
      },
    }),
    passkey({
      rpID: new URL(baseURL).hostname,
      rpName: "CampTool",
      origin: baseURL,
    }),
  ],
});

export const discordEnabled = discordConfigured;
