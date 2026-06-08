import { Buffer } from "node:buffer";

/** A URL-safe, hard-to-guess invite token (192 bits of entropy). */
export function newInviteToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}
