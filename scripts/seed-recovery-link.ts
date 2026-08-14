/**
 * Seed one account + camp + recovery link and print the link URL.
 *
 * Split out from `e2e/passkey-recovery.ts` because that file runs under NODE
 * (Playwright hangs under Bun) while this needs the app's Bun-only DB layer.
 * The harness runs this first and passes the URL through E2E_RECOVERY_URL.
 *
 *   bun scripts/seed-recovery-link.ts <email>
 */
import { eq } from "drizzle-orm";
import { issuePasswordReset } from "../app/lib/password-reset.server";
import { db } from "../db/client.server";
import { camp, membership, user } from "../db/schema";

const email = process.argv[2];
if (!email) {
  console.error("usage: bun scripts/seed-recovery-link.ts <email>");
  process.exit(1);
}
const BASE = process.env.PUBLIC_BASE_URL ?? "http://localhost:17934";

// Create the account through the real signup endpoint so it's shaped exactly
// like any other member (it starts WITH a password, and no passkey — the state
// a locked-out member is actually in).
const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Recovery Tester", email, password: "start-1" }),
});
if (!res.ok) {
  console.error("signup failed", res.status, await res.text());
  process.exit(1);
}

const [u] = await db.select().from(user).where(eq(user.email, email)).limit(1);
if (!u) {
  console.error("no user row after signup");
  process.exit(1);
}

const campId = crypto.randomUUID();
await db.insert(camp).values({
  id: campId,
  name: `Recovery Camp ${campId.slice(0, 6)}`,
  slug: `rec-${campId.slice(0, 6)}`,
});
await db.insert(membership).values({
  id: crypto.randomUUID(),
  organizationId: campId,
  userId: u.id,
  role: "member",
});

const { url } = await issuePasswordReset({
  campId,
  userId: u.id,
  issuedByMembershipId: null,
});
console.log(url);
