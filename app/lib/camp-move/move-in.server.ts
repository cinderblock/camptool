/**
 * Fetching a camp from the install it's leaving (plans/camp-portability.md,
 * "Overview"): with the move code, over the source's pull API, or from a
 * bundle file when the two installs can't reach each other.
 *
 * Server-only.
 */

import { APEX } from "../env.server";
import {
  type Manifest,
  type MoveCode,
  parseMoveCode,
  secretHash,
  unpackBundle,
} from "./bundle";
import type { BundleSource } from "./import.server";

export type FetchedBundle = {
  code: MoveCode;
  source: BundleSource;
  /** The key the manifest must be signed with. */
  trustedKey: string;
  /** False when the source couldn't be reached to confirm its key (a bundle
   * file on its own only proves it wasn't damaged, not where it came from). */
  confirmed: boolean;
};

const TIMEOUT_MS = 20_000;

export class MoveFetchError extends Error {}

async function get(url: string, bearer?: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new MoveFetchError(
      `Couldn't reach ${new URL(url).origin}. Check the code, or use a bundle file.`,
    );
  }
  if (res.status === 404) {
    throw new MoveFetchError(
      "The old install doesn't know this code (wrong, expired, cancelled or already used).",
    );
  }
  if (!res.ok) {
    throw new MoveFetchError(`The old install answered ${res.status}.`);
  }
  return res;
}

const api = (c: MoveCode, what: string) =>
  `${c.origin}/api/move/${c.moveId}/${what}`;

export function readCode(raw: string): MoveCode {
  const code = parseMoveCode(raw);
  if (!code) {
    throw new MoveFetchError(
      "That isn't a move code. It starts with camptool-move:1:",
    );
  }
  // The code names a server this one will fetch from, so keep it to real
  // sites: HTTPS, and no private addresses, except when this install itself
  // runs over plain HTTP (a local test setup).
  const url = new URL(code.origin);
  const local = APEX.protocol === "http:";
  if (!local && (url.protocol !== "https:" || isPrivateHost(url.hostname))) {
    throw new MoveFetchError("The old install must be a public HTTPS site.");
  }
  return code;
}

/** Loopback, private and link-local addresses, and single-label names. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  // IPv6 literals aren't how a camp's site is addressed; refuse them all.
  if (h.includes(":")) return true;
  if (h === "localhost" || h.endsWith(".localhost") || !h.includes(".")) {
    return true;
  }
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

async function sourceKey(code: MoveCode): Promise<string> {
  const { publicKey } = (await (await get(api(code, "key"))).json()) as {
    publicKey: string;
  };
  return publicKey;
}

/** The bundle, pulled from the old install. Files are fetched on demand. */
export async function pullBundle(rawCode: string): Promise<FetchedBundle> {
  const code = readCode(rawCode);
  const bearer = await secretHash(code.secret);
  const trustedKey = await sourceKey(code);
  const body = (await (await get(api(code, "bundle"), bearer)).json()) as {
    manifest: Manifest;
    signature: string;
    rows: Record<string, string>;
  };
  if (
    body.manifest.move.id !== code.moveId ||
    body.manifest.move.publicKey !== trustedKey
  ) {
    throw new MoveFetchError("The bundle isn't the one this code is for.");
  }
  return {
    code,
    trustedKey,
    confirmed: true,
    source: {
      manifest: body.manifest,
      signature: body.signature,
      rows: async (t) => body.rows[t] ?? "",
      file: async (key) =>
        new Uint8Array(
          await (
            await get(
              `${api(code, "file")}?key=${encodeURIComponent(key)}`,
              bearer,
            )
          ).arrayBuffer(),
        ),
    },
  };
}

/** The bundle, from a file the old install's admin downloaded. */
export async function bundleFromFile(
  file: Uint8Array,
  rawCode: string,
): Promise<FetchedBundle> {
  const code = readCode(rawCode);
  let parts: Awaited<ReturnType<typeof unpackBundle>>;
  try {
    parts = await unpackBundle(file, code.secret);
  } catch (e) {
    throw new MoveFetchError(e instanceof Error ? e.message : String(e));
  }
  if (parts.manifest.move.id !== code.moveId) {
    throw new MoveFetchError("The file isn't the one this code is for.");
  }
  let trustedKey = parts.manifest.move.publicKey;
  let confirmed = false;
  try {
    const key = await sourceKey(code);
    if (key !== trustedKey) {
      throw new MoveFetchError("The file wasn't signed by the old install.");
    }
    trustedKey = key;
    confirmed = true;
  } catch (e) {
    if (e instanceof MoveFetchError && e.message.includes("signed")) throw e;
  }
  return {
    code,
    trustedKey,
    confirmed,
    source: {
      manifest: parts.manifest,
      signature: parts.signature,
      rows: async (t) => parts.rows.get(t) ?? "",
      file: async (k) => parts.files.get(k) ?? new Uint8Array(),
    },
  };
}

/**
 * Tell the old install the camp arrived, so it deletes its copy and starts
 * forwarding. False when it couldn't be told (unreachable): its admin then
 * marks the move done by hand.
 */
export async function confirmToSource(
  code: MoveCode,
  target: { origin: string; campUrl: string },
): Promise<boolean> {
  try {
    const res = await fetch(api(code, "done"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await secretHash(code.secret)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetOrigin: target.origin,
        targetCampUrl: target.campUrl,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    return res.ok;
  } catch {
    return false;
  }
}
