import { describe, expect, test } from "bun:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { BLOCK_SIZE, tarHeader, tarPadding, tarTrailer } from "./tar";

const text = (bytes: Uint8Array, from: number, length: number) =>
  new TextDecoder()
    .decode(bytes.slice(from, from + length))
    .replace(/\0+$/, "");

/**
 * A deliberately independent reader: it walks the blocks the way `tar` does
 * rather than reusing the writer's own constants. A backup format that only
 * round-trips through its own assumptions is how you get an archive that no
 * real tool can open.
 */
function parseTar(
  archive: Uint8Array,
): Array<{ name: string; body: Uint8Array }> {
  const out: Array<{ name: string; body: Uint8Array }> = [];
  let offset = 0;
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.slice(offset, offset + BLOCK_SIZE);
    if (header.every((b) => b === 0)) break; // trailer
    const name = text(header, 0, 100);
    const size = Number.parseInt(text(header, 124, 12).trim() || "0", 8);

    // Verify the checksum the way an extractor would.
    const zeroed = Uint8Array.from(header);
    for (let i = 148; i < 156; i++) zeroed[i] = 0x20;
    let sum = 0;
    for (const b of zeroed) sum += b;
    const stored = Number.parseInt(text(header, 148, 8).trim() || "-1", 8);
    if (sum !== stored) throw new Error(`bad checksum for ${name}`);
    if (text(header, 257, 6) !== "ustar") throw new Error(`not ustar: ${name}`);

    offset += BLOCK_SIZE;
    out.push({ name, body: archive.slice(offset, offset + size) });
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return out;
}

/** Assemble entries the way backup.server.ts does. */
function buildTar(
  entries: Array<{ name: string; body: Uint8Array }>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    parts.push(tarHeader(e.name, e.body.byteLength, 1_700_000_000));
    parts.push(e.body);
    const pad = tarPadding(e.body.byteLength);
    if (pad) parts.push(pad);
  }
  parts.push(tarTrailer());
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

describe("tarHeader", () => {
  test("is exactly one block", () => {
    expect(tarHeader("a.txt", 1, 0).byteLength).toBe(BLOCK_SIZE);
  });

  test("declares itself USTAR and a regular file", () => {
    const h = tarHeader("a.txt", 5, 0);
    expect(text(h, 257, 6)).toBe("ustar");
    expect(h[156]).toBe(0x30);
  });

  test("writes the size as NUL-terminated octal", () => {
    const h = tarHeader("a.txt", 1234, 0);
    expect(text(h, 124, 12)).toBe("00000002322");
    expect(Number.parseInt(text(h, 124, 12), 8)).toBe(1234);
  });

  test("refuses a name too long to store, rather than truncating it", () => {
    // Silent truncation in a BACKUP is the failure you only find on restore.
    expect(() => tarHeader("x".repeat(101), 0, 0)).toThrow(/too long/);
    expect(() => tarHeader("x".repeat(100), 0, 0)).not.toThrow();
  });

  test("the longest path this app writes still fits", () => {
    const longest = `uploads/${"a".repeat(36)}/${"b".repeat(36)}.display`;
    expect(longest.length).toBeLessThanOrEqual(100);
    expect(() => tarHeader(longest, 0, 0)).not.toThrow();
  });
});

describe("tarPadding", () => {
  test("pads a partial block up to 512", () => {
    expect(tarPadding(1)?.byteLength).toBe(511);
    expect(tarPadding(500)?.byteLength).toBe(12);
  });

  test("a whole number of blocks needs none", () => {
    expect(tarPadding(0)).toBeNull();
    expect(tarPadding(512)).toBeNull();
    expect(tarPadding(1024)).toBeNull();
  });
});

describe("a built archive", () => {
  const db = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66]);
  const manifest = new TextEncoder().encode("CampTool backup\n");
  const picture = new Uint8Array(1000).fill(7);

  test("round-trips every entry, byte for byte", () => {
    const archive = buildTar([
      { name: "MANIFEST.txt", body: manifest },
      { name: "camptool.db", body: db },
      { name: "uploads/camp-1/pic-1", body: picture },
    ]);
    const parsed = parseTar(archive);
    expect(parsed.map((e) => e.name)).toEqual([
      "MANIFEST.txt",
      "camptool.db",
      "uploads/camp-1/pic-1",
    ]);
    expect(parsed[1]?.body).toEqual(db);
    expect(parsed[2]?.body).toEqual(picture);
  });

  test("an empty file is a valid entry", () => {
    const parsed = parseTar(
      buildTar([{ name: "empty", body: new Uint8Array() }]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.body.byteLength).toBe(0);
  });

  test("every entry lands on a block boundary", () => {
    const archive = buildTar([
      { name: "odd", body: new Uint8Array(3) },
      { name: "after", body: new Uint8Array([9]) },
    ]);
    expect(archive.byteLength % BLOCK_SIZE).toBe(0);
    // The second entry is only readable at all if the first was padded right.
    expect(parseTar(archive)[1]?.body).toEqual(new Uint8Array([9]));
  });

  test("ends with two zero blocks", () => {
    const archive = buildTar([{ name: "a", body: new Uint8Array([1]) }]);
    expect(archive.slice(-BLOCK_SIZE * 2).every((b) => b === 0)).toBe(true);
  });

  test("survives a gzip round-trip", () => {
    // node:zlib, not CompressionStream — Bun 1.3 doesn't define the web API,
    // which is exactly why backup.server.ts gzips this way too.
    const archive = buildTar([{ name: "camptool.db", body: db }]);
    const back = new Uint8Array(gunzipSync(gzipSync(archive)));
    expect(parseTar(back)[0]?.body).toEqual(db);
  });
});
