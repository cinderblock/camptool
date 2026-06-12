import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { magicLink, organization } from "better-auth/plugins";
import { db, schema } from "../../db/client.server";
import {
  ensureFirstUserSuperAdmin,
  getInstanceSettings,
  hasSignupUnlock,
  isSuperAdmin,
} from "./instance.server";
import { ac, roles } from "./permissions";

const baseURL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

// localhost cookies are scoped by host, not port, so on a shared dev box every
// better-auth app collides on the default `better-auth.session_token`. We only
// namespace the cookie there; in production each deployment owns its own domain,
// so the default name is already isolated and needs no prefix.
const isLocalDev = ["localhost", "127.0.0.1", "[::1]"].includes(
  new URL(baseURL).hostname,
);

// Discord is optional: email/password + magic link + passkeys all work without
// it. When these two env vars are present, Discord login lights up automatically.
const discordConfigured = Boolean(
  process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET,
);

// In local dev the server is reached at http://localhost:<port> even when
// PUBLIC_BASE_URL points at a tunnel or real domain, so the browser Origin won't
// match baseURL. better-auth only runs its origin check when a request carries a
// cookie, so signups normally slipped past it — but the invite-only unlock cookie
// makes every signup cookie-bearing. Trust localhost in dev so those pass the
// origin check; production trusts only its real domain.
const devOrigins =
  process.env.NODE_ENV === "production"
    ? []
    : [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
      ];

export const auth = betterAuth({
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [baseURL, ...devOrigins],

  // See isLocalDev above: prefix dev cookies to dodge cross-app collisions on
  // localhost; leave production on the default name (its domain isolates it).
  ...(isLocalDev ? { advanced: { cookiePrefix: "camptool" } } : {}),

  database: drizzleAdapter(db, { provider: "sqlite", schema }),

  // Instance-level lockdowns. New-user creation is gated here so it covers
  // EVERY signup path (email/password, magic link, Discord) at the one point a
  // user row is actually created — passkey never creates a user, so it's exempt.
  databaseHooks: {
    user: {
      create: {
        before: async (newUser, ctx) => {
          const { allowOpenSignups } = await getInstanceSettings();
          if (allowOpenSignups) return;
          // Invite-only: allow only when the request reached us from a
          // sanctioned entry point (invite link / public apply page), which
          // drops a short-lived signed cookie we verify here.
          const headers = ctx?.headers ?? ctx?.request?.headers ?? null;
          if (hasSignupUnlock(headers)) return;
          throw new APIError("FORBIDDEN", {
            message:
              "New sign-ups are invite-only on this deployment. Ask your camp for an invite link.",
          });
        },
        after: async (newUser) => {
          // First account on a fresh deployment becomes the super admin.
          await ensureFirstUserSuperAdmin(newUser.id);
        },
      },
    },
  },

  emailAndPassword: { enabled: true, minPasswordLength: 6 },

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
      // Lock down new-camp creation to super admins when the instance toggle is
      // off. Super admins can always create camps.
      allowUserToCreateOrganization: async (u: { id: string }) => {
        if (await isSuperAdmin(u.id)) return true;
        const { allowCampCreation } = await getInstanceSettings();
        return allowCampCreation;
      },
      schema: {
        organization: { modelName: "camp" },
        member: {
          modelName: "membership",
          additionalFields: {
            playaName: { type: "string", required: false, input: true },
            status: { type: "string", required: false, input: true },
            // Server-set, not client-writable.
            joinedAt: { type: "date", required: false, input: false },
            invitedByMembershipId: {
              type: "string",
              required: false,
              input: false,
            },
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
