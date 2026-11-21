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
  untar,
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

/** Same site or a subdomain of it. */
const within = (host: string, site: string) =>
  host === site || host.endsWith(`.${site}`);

/**
 * The bundle's idea of where it came from must agree with the code: the code
 * is what the camp's admin handed over, the manifest is the old site's say.
 * The login page shows these to everyone, so a mismatch is refused.
 */
export function sourceProblem(m: Manifest, code: MoveCode): string | null {
  const origin = new URL(code.origin);
  if (m.source.origin !== code.origin) {
    return "The bundle says it came from somewhere other than the code's site.";
  }
  if (!within(origin.hostname, m.source.rpId)) {
    return "The bundle's passkey site doesn't match the code's site.";
  }
  try {
    const camp = new URL(m.source.campUrl);
    if (
      camp.protocol !== origin.protocol ||
      !within(camp.hostname, origin.hostname)
    ) {
      return "The bundle's camp address isn't on the code's site.";
    }
  } catch {
    return "The bundle's camp address is malformed.";
  }
  return null;
}

/** Refuse a host name that resolves to a private address (Bun hosts only:
 * Workers can't reach private networks anyway). */
async function assertPublicAddress(host: string) {
  if (APEX.protocol === "http:") return; // a local test setup
  if (
    typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers"
  ) {
    return;
  }
  let addresses: { address: string }[] = [];
  try {
    const dns = await import("node:dns/promises");
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new MoveFetchError(`Couldn't look up ${host}.`);
  }
  if (addresses.some((a) => isPrivateHost(a.address))) {
    throw new MoveFetchError("The old install must be a public site.");
  }
}

async function get(url: string, bearer?: string): Promise<Response> {
  await assertPublicAddress(new URL(url).hostname);
  // A busy old site may ask us to slow down (per-visitor limits): wait as
  // told, a few times, before giving up.
  for (let attempt = 0; ; attempt++) {
    const res = await getOnce(url, bearer);
    if (res.status !== 429 || attempt >= 6) return checked(res, url);
    const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
  }
}

async function getOnce(url: string, bearer?: string): Promise<Response> {
  try {
    return await fetch(url, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Workers refuse "error"; a redirect is treated as a failure below.
      redirect: "manual",
    });
  } catch (e) {
    console.warn(`camp move: fetching ${url} failed`, e);
    throw new MoveFetchError(
      `Couldn't reach ${new URL(url).origin}. Check the code, or use a bundle file.`,
    );
  }
}

function checked(res: Response, url: string): Response {
  if (res.status >= 300 && res.status < 400) {
    throw new MoveFetchError(
      `${new URL(url).origin} redirected the move somewhere else; use the address in the code exactly.`,
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
  // IPv4 written as IPv6 (`::ffff:10.0.0.1`).
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateHost(mapped[1]);
  // IPv6: loopback, unique-local, link-local, unspecified.
  if (h.includes(":")) {
    return h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  }
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
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
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
  const wrong = sourceProblem(body.manifest, code);
  if (wrong) throw new MoveFetchError(wrong);
  return {
    code,
    trustedKey,
    confirmed: true,
    source: {
      manifest: body.manifest,
      signature: body.signature,
      rows: async (t) => body.rows[t] ?? "",
      file: batchedFiles(code, bearer, body.manifest),
    },
  };
}

/**
 * Files from the old site a batch at a time (`/files?start=`), in the
 * manifest's order, handing each over once and keeping only the current
 * batch in memory.
 */
function batchedFiles(code: MoveCode, bearer: string, m: Manifest) {
  const index = new Map(m.files.map((f, i) => [f.key, i]));
  let held = new Map<string, Uint8Array>();
  return async (key: string): Promise<Uint8Array> => {
    const got = held.get(key);
    if (got) {
      held.delete(key);
      return got;
    }
    const start = index.get(key);
    if (start === undefined) throw new MoveFetchError(`No file ${key}.`);
    const res = await get(`${api(code, "files")}?start=${start}`, bearer);
    held = untar(new Uint8Array(await res.arrayBuffer()));
    const first = held.get(key);
    if (!first) throw new MoveFetchError(`The old site didn't send ${key}.`);
    held.delete(key);
    return first;
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
  const wrong = sourceProblem(parts.manifest, code);
  if (wrong) throw new MoveFetchError(wrong);
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
      // Workers refuse "error"; a redirect is treated as a failure below.
      redirect: "manual",
    });
    return res.ok;
  } catch {
    return false;
  }
}
