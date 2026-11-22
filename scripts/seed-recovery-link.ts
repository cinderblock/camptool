/**
 * Seed one account + camp + recovery link and print the link URL.
 *
 * Split out from `e2e/passkey-recovery.ts` because that file runs under NODE
 * (Playwright hangs under Bun) while this needs the app's Bun-only DB layer.
 * The harness runs this first and passes the URL through E2E_RECOVERY_URL.
 *
 * Inserts the user directly so this works even when `allowPasswordLogin` is
 * false (the default).
 *
 *   bun scripts/seed-recovery-link.ts <email>
 */
import { issuePasswordReset } from "../app/lib/password-reset.server";
import { db } from "../db/client.server";
import { camp, membership, user } from "../db/schema";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("usage: bun scripts/seed-recovery-link.ts <email>");
  process.exit(1);
}

const userId = crypto.randomUUID();
await db.insert(user).values({
  id: userId,
  name: "Recovery Tester",
  email,
  emailVerified: false,
});

const campId = crypto.randomUUID();
await db.insert(camp).values({
  id: campId,
  name: `Recovery Camp ${campId.slice(0, 6)}`,
  slug: `rec-${campId.slice(0, 6)}`,
});
await db.insert(membership).values({
  id: crypto.randomUUID(),
  organizationId: campId,
  userId,
  role: "member",
});

const { url } = await issuePasswordReset({
  campId,
  userId,
  issuedByMembershipId: null,
});
console.log(url);
