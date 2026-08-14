import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { magicLink, organization } from "better-auth/plugins";
import { db, schema } from "../../db/client.server";
import { DEV_PORT, PUBLIC_BASE_URL } from "./env.server";
import {
  ensureFirstUserSuperAdmin,
  getInstanceSettings,
  hasSignupUnlock,
  isSuperAdmin,
} from "./instance.server";
import {
  completePasskeyRecovery,
  readPendingRecovery,
} from "./passkey-recovery.server";
import {
  consumePendingSignup,
  readPendingSignup,
} from "./passkey-signup.server";
import { ac, roles } from "./permissions";

const baseURL = PUBLIC_BASE_URL;

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
        `http://localhost:${DEV_PORT}`,
        `http://127.0.0.1:${DEV_PORT}`,
        `http://[::1]:${DEV_PORT}`,
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
  // EVERY signup path (email/password, magic link, Discord, and now passkey) at
  // the one point a user row is actually created. Passkey-first signup reaches
  // this via internalAdapter.createUser in the plugin's afterVerification; the
  // request context (and so the unlock cookie) arrives through better-auth's
  // async-storage context, not the explicit argument. The passkey path ALSO
  // checks the gate earlier, in resolveUser, to fail before the WebAuthn prompt
  // rather than after it.
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

      // `signIn.passkey()` with no email is a DISCOVERABLE-credential ceremony
      // — the authenticator has to be able to enumerate its own credentials for
      // this site. Without residentKey the browser may create a non-discoverable
      // credential that usernameless sign-in then can't find. We relied on
      // platform defaults before; passkey-first makes that unacceptable.
      // userVerification stays "preferred", not "required", so an authenticator
      // with no biometric/PIN capability degrades instead of hard-failing.
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "preferred",
      },

      // Passkey-first signup: create an account with no password at all.
      // Contrary to the note on the user-create hook above, passkey CAN now
      // create users — see the gate re-check in resolveUser.
      registration: {
        requireSession: false,

        // Runs at generate-register-options time. The plugin calls this ONLY
        // when there's no session (an existing user adding a passkey takes the
        // session branch and never reaches here).
        resolveUser: async ({ ctx, context }) => {
          // RECOVERY first, and deliberately BEFORE the invite-only gate: this
          // branch attaches a credential to an account that already exists
          // (an officer-issued link — see plans/password-recovery.md), so it
          // creates nothing for the lockdown to guard. Gating it would lock a
          // camp's own members out of an invite-only deployment, which is
          // exactly backwards.
          const recovery = await readPendingRecovery(context);
          if (recovery) {
            return {
              id: recovery.userId,
              name: recovery.email,
              displayName: recovery.name,
            };
          }

          // The invite-only lockdown normally lives in databaseHooks.user.create
          // .before. That hook does still fire for the user we create later
          // (better-auth's createWithHooks picks the request context up from
          // async storage), but failing there means failing AFTER the visitor
          // has completed a WebAuthn ceremony. Check here too so an invite-only
          // deployment refuses before the browser prompt, not after.
          const { allowOpenSignups } = await getInstanceSettings();
          if (!allowOpenSignups) {
            const headers = ctx?.headers ?? ctx?.request?.headers ?? null;
            if (!hasSignupUnlock(headers)) {
              throw new APIError("FORBIDDEN", {
                message:
                  "New sign-ups are invite-only on this deployment. Ask your camp for an invite link.",
              });
            }
          }

          const pending = await readPendingSignup(context);
          if (!pending) {
            throw new APIError("BAD_REQUEST", {
              message: "That signup link expired. Start again.",
            });
          }
          // `name` is the WebAuthn account identifier shown in the passkey
          // manager; displayName is the human label. Return the PRE-GENERATED
          // id so the credential's user handle matches the row we create in
          // afterVerification.
          return {
            id: pending.userId,
            name: pending.email,
            displayName: pending.name,
          };
        },

        // Runs only after the credential is cryptographically verified, so an
        // abandoned prompt leaves no orphan account behind.
        afterVerification: async ({ ctx, context }) => {
          // Recovery: the credential is verified, so spend the officer's link
          // and drop the account's old sessions. No user row is created — it
          // already exists — we just point the credential at it.
          const recovered = await completePasskeyRecovery(context ?? "");
          if (recovered) return { userId: recovered.userId };

          const pending = await consumePendingSignup(context);
          // No pending row = an already-signed-in user adding a passkey. Leave
          // the plugin's own userId resolution alone.
          if (!pending) return;

          // internalAdapter (not the raw adapter) so the user create hooks fire
          // — that's what promotes the first account to super admin and applies
          // the invite-only gate. It honors our supplied id (forceAllowId).
          const created = await ctx.context.internalAdapter.createUser({
            id: pending.userId,
            name: pending.name,
            email: pending.email,
            emailVerified: false,
          });
          if (!created) {
            throw new APIError("UNPROCESSABLE_ENTITY", {
              message: "Could not create your account.",
            });
          }
          return { userId: created.id };
        },
      },
    }),
  ],
});

export const discordEnabled = discordConfigured;
