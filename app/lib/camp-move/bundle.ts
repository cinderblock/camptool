/**
 * The camp bundle: one camp's rows and files, as they travel between installs
 * (plans/camp-portability.md, "Bundle format"). Format version 1.
 *
 * Pure and host-neutral (WebCrypto, no disk): the pull API serves the pieces
 * one by one; `packBundle` / `unpackBundle` make the single encrypted file
 * for moves where the target can't reach the source.
 *
 *   manifest.json        what's inside, with a SHA-256 per table and file
 *   manifest.sig         Ed25519 signature of manifest.json (the move's key)
 *   rows/<table>.jsonl   one row per line, keyed by SQL column name
 *   files/<key>          uploads, under their blob keys (`<campId>/…`)
 */
import { Buffer } from "node:buffer";
import { gunzipSync, gzipSync } from "node:zlib";
import journal from "../../../db/migrations/meta/_journal.json";
import { tarHeader, tarPadding, tarTrailer } from "../tar";
import type { Row } from "./remap";

export const FORMAT = "camptool-camp";
export const FORMAT_VERSION = 1;

export type Manifest = {
  format: typeof FORMAT;
  formatVersion: number;
  /** Epoch ms. */
  createdAt: number;
  /** Every migration the source's schema has, in order. */
  migrations: string[];
  source: {
    /** e.g. `https://camptool.org`. */
    origin: string;
    /** Where the camp's pages were, e.g. `https://mathcamp.camptool.org`. */
    campUrl: string;
    /** The passkey RP ID its members' passkeys belong to. */
    rpId: string;
  };
  move: {
    id: string;
    /** Ed25519 public key, raw, base64url. Signs login hand-offs. */
    publicKey: string;
  };
  camp: { id: string; slug: string | null; name: string };
  tables: Record<string, { columns: string[]; rows: number; sha256: string }>;
  files: { key: string; size: number; sha256: string }[];
  /** People whose accounts travel with the camp. */
  people: number;
  /** Rows left out because they needed someone who isn't coming, per table. */
  dropped: Record<string, number>;
};

/** This install's schema version: every migration it knows. */
export function localMigrations(): string[] {
  return journal.entries.map((e) => e.tag);
}

// --- Rows as text ---

/** One table's rows as JSON lines. BLOB values become `{"$b64": "…"}`. */
export function encodeRows(rows: Row[]): string {
  return rows
    .map((r) =>
      JSON.stringify(r, (_k, v) =>
        v instanceof Uint8Array || v instanceof ArrayBuffer
          ? { $b64: Buffer.from(v as Uint8Array).toString("base64") }
          : typeof v === "bigint"
            ? Number(v)
            : v,
      ),
    )
    .map((l) => `${l}\n`)
    .join("");
}

export function decodeRows(text: string): Row[] {
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) =>
      JSON.parse(l, (_k, v) =>
        v && typeof v === "object" && typeof v.$b64 === "string"
          ? new Uint8Array(Buffer.from(v.$b64, "base64"))
          : v,
      ),
    );
}

export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Buffer.from(d).toString("hex");
}

// --- Signing (Ed25519, WebCrypto: Bun and Workers both have it) ---

const b64u = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b as Uint8Array).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

export type MoveKeys = { publicKey: string; privateKey: string };

/** A fresh key pair for one move: public raw, private PKCS#8, base64url. */
export async function newMoveKeys(): Promise<MoveKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    publicKey: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateKey: b64u(
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    ),
  };
}

export async function sign(privateKey: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    unb64u(privateKey),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return b64u(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      new TextEncoder().encode(data),
    ),
  );
}

export async function verify(
  publicKey: string,
  data: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      unb64u(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      unb64u(signature),
      new TextEncoder().encode(data),
    );
  } catch {
    return false;
  }
}

// --- The move code ---

export const CODE_PREFIX = "camptool-move:1:";

export type MoveCode = { origin: string; moveId: string; secret: string };

/** `camptool-move:1:<origin>:<move id>:<secret>`. The origin keeps its own
 * colons (`https://…:8443`), so it's split from the right. */
export function formatMoveCode(c: MoveCode): string {
  return `${CODE_PREFIX}${c.origin}:${c.moveId}:${c.secret}`;
}

export function parseMoveCode(raw: string): MoveCode | null {
  const s = raw.trim();
  if (!s.startsWith(CODE_PREFIX)) return null;
  const rest = s.slice(CODE_PREFIX.length);
  const secretAt = rest.lastIndexOf(":");
  const idAt = rest.lastIndexOf(":", secretAt - 1);
  if (idAt < 1) return null;
  const origin = rest.slice(0, idAt);
  const moveId = rest.slice(idAt + 1, secretAt);
  const secret = rest.slice(secretAt + 1);
  try {
    if (new URL(origin).origin !== origin) return null;
  } catch {
    return null;
  }
  if (!/^[0-9a-f-]{36}$/.test(moveId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    return null;
  }
  return { origin, moveId, secret };
}

export function newSecret(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(32)));
}

/** What the source stores and the pull API takes as its bearer token. */
export function secretHash(secret: string): Promise<string> {
  return sha256(`camptool-move-bearer:${secret}`);
}

// --- The single-file form ---

const MAGIC = new TextEncoder().encode("CAMPTOOL-MOVE-1\n");

/** The largest bundle file (unpacked) this code will open. 128 MiB is the
 * most Workers' zlib will inflate in one go (and a Worker's whole memory);
 * bigger camps move by code, which fetches files one at a time. */
export const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;

export type BundleParts = {
  manifest: Manifest;
  signature: string;
  rows: Map<string, string>;
  files: Map<string, Uint8Array>;
};

/** Text that `manifest.sig` signs: the manifest exactly as stored. */
export function manifestText(m: Manifest): string {
  return JSON.stringify(m, null, 2);
}

export function tar(entries: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const [name, bytes] of entries) {
    parts.push(tarHeader(name, bytes.length, now), bytes);
    const pad = tarPadding(bytes.length);
    if (pad) parts.push(pad);
  }
  parts.push(tarTrailer());
  return Buffer.concat(parts);
}

/** Read a USTAR archive written by `tar()` (regular files, short names). */
export function untar(data: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let at = 0;
  const text = (o: number, n: number) =>
    new TextDecoder().decode(data.subarray(o, o + n)).replace(/\0.*$/s, "");
  while (at + 512 <= data.length) {
    const name = text(at, 100);
    if (!name) break;
    const size = Number.parseInt(text(at + 124, 12).trim() || "0", 8);
    const start = at + 512;
    out.set(name, data.slice(start, start + size));
    at = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

async function aesKey(secret: string) {
  return crypto.subtle.importKey("raw", unb64u(secret), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** The whole bundle as one file, encrypted with the move code's secret. */
export async function packBundle(
  parts: BundleParts,
  secret: string,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const entries: [string, Uint8Array][] = [
    ["manifest.json", enc.encode(manifestText(parts.manifest))],
    ["manifest.sig", enc.encode(parts.signature)],
  ];
  for (const [t, text] of parts.rows) {
    entries.push([`rows/${t}.jsonl`, enc.encode(text)]);
  }
  for (const [k, bytes] of parts.files) entries.push([`files/${k}`, bytes]);
  const plain = gzipSync(tar(entries));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await aesKey(secret),
      plain,
    ),
  );
  return Buffer.concat([MAGIC, iv, sealed]);
}

/** Open a bundle file. Throws on a wrong code or a damaged file. */
export async function unpackBundle(
  file: Uint8Array,
  secret: string,
): Promise<BundleParts> {
  const head = file.subarray(0, MAGIC.length);
  if (Buffer.compare(head, MAGIC) !== 0) {
    throw new Error("This isn't a CampTool camp bundle.");
  }
  const iv = file.slice(MAGIC.length, MAGIC.length + 12) as BufferSource;
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        await aesKey(secret),
        file.subarray(MAGIC.length + 12) as BufferSource,
      ),
    );
  } catch {
    throw new Error("The move code doesn't open this bundle.");
  }
  let tarBytes: Uint8Array;
  try {
    // A bundle that inflates past this is refused rather than allowed to
    // exhaust the server's memory.
    tarBytes = gunzipSync(plain, { maxOutputLength: MAX_BUNDLE_BYTES });
  } catch (e) {
    console.warn("camp move: gunzip failed", e);
    throw new Error("The bundle is damaged or too large.");
  }
  const entries = untar(tarBytes);
  const dec = new TextDecoder();
  const manifestRaw = entries.get("manifest.json");
  if (!manifestRaw) throw new Error("The bundle has no manifest.");
  const parts: BundleParts = {
    manifest: JSON.parse(dec.decode(manifestRaw)),
    signature: dec.decode(entries.get("manifest.sig") ?? new Uint8Array()),
    rows: new Map(),
    files: new Map(),
  };
  for (const [name, bytes] of entries) {
    if (name.startsWith("rows/") && name.endsWith(".jsonl")) {
      parts.rows.set(name.slice(5, -6), dec.decode(bytes));
    } else if (name.startsWith("files/")) {
      parts.files.set(name.slice(6), bytes);
    }
  }
  return parts;
}

/**
 * Check a bundle against its manifest: format, signature, and every table and
 * file's hash. Returns the problems; empty means it's intact.
 */
export async function checkBundle(
  parts: Pick<BundleParts, "manifest" | "signature" | "rows">,
  files: Map<string, Uint8Array> | null,
  publicKey: string,
): Promise<string[]> {
  const m = parts.manifest;
  const problems: string[] = [];
  if (m.format !== FORMAT) return ["Not a CampTool camp bundle."];
  if (m.formatVersion > FORMAT_VERSION) {
    return [
      `Bundle format ${m.formatVersion} is newer than this install understands (${FORMAT_VERSION}). Update this install first.`,
    ];
  }
  if (!(await verify(publicKey, manifestText(m), parts.signature))) {
    problems.push("The manifest's signature doesn't match the source's key.");
  }
  for (const [t, info] of Object.entries(m.tables)) {
    const text = parts.rows.get(t);
    if (text === undefined) problems.push(`Missing rows for ${t}.`);
    else if ((await sha256(text)) !== info.sha256) {
      problems.push(`Rows for ${t} are damaged.`);
    }
  }
  if (files) {
    for (const f of m.files) {
      const b = files.get(f.key);
      if (!b) problems.push(`Missing file ${f.key}.`);
      else if ((await sha256(b)) !== f.sha256) {
        problems.push(`File ${f.key} is damaged.`);
      }
    }
  }
  return problems;
}
