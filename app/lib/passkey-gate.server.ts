/**
 * Server-side passkey readiness checks for one-use doors (`/new-camp/:token`,
 * `/i/:token`, etc.) so a visitor can't accidentally consume a setup or invite
 * link before they have a working passkey in a real browser.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db/client.server";
import { passkey } from "../../db/schema";
import { detectInAppBrowser, type InAppBrowser } from "./in-app-browser";

export function requestInAppBrowser(request: Request): InAppBrowser | null {
  return detectInAppBrowser(request.headers.get("user-agent") ?? "");
}

export async function hasUserPasskey(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: passkey.id })
    .from(passkey)
    .where(eq(passkey.userId, userId))
    .limit(1);
  return Boolean(row);
}

/**
 * Refuse consuming a setup or invite link when passkey-only mode is active
 * (`!allowPasswordLogin`) and the signed-in user does not yet have a passkey.
 * Returns a human-readable error message, or null when the action may proceed.
 */
export async function passkeyGateError(
  request: Request,
  userId: string,
  allowPasswordLogin: boolean,
): Promise<string | null> {
  if (allowPasswordLogin) return null;
  if (await hasUserPasskey(userId)) return null;
  const inApp = requestInAppBrowser(request);
  if (inApp) {
    return `Open this link in ${inApp.realBrowser} first — ${inApp.appName}'s built-in browser can't set up a passkey. Your link hasn't been used yet.`;
  }
  return "Set up a passkey first so you can sign back in later. Your link hasn't been used yet.";
}
