import { describe, expect, it } from "bun:test";
import {
  type BundleParts,
  checkBundle,
  decodeRows,
  encodeRows,
  FORMAT,
  FORMAT_VERSION,
  formatMoveCode,
  type Manifest,
  manifestText,
  newMoveKeys,
  newSecret,
  packBundle,
  parseMoveCode,
  sha256,
  sign,
  unpackBundle,
  verify,
} from "./bundle";

const MOVE_ID = "33333333-3333-4333-8333-333333333333";

async function sample() {
  const keys = await newMoveKeys();
  const rowsText = encodeRows([
    { id: "a", n: 1, blob: new Uint8Array([0, 255]), none: null },
  ]);
  const file = new Uint8Array([7, 7, 7]);
  const manifest: Manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: 1,
    migrations: ["0000_x"],
    source: {
      origin: "https://camptool.org",
      campUrl: "https://a.camptool.org",
      rpId: "camptool.org",
    },
    move: { id: MOVE_ID, publicKey: keys.publicKey },
    camp: { id: "c", slug: "a", name: "A" },
    tables: {
      camp: { columns: ["id"], rows: 1, sha256: await sha256(rowsText) },
    },
    files: [{ key: "c/f", size: 3, sha256: await sha256(file) }],
    people: 0,
    dropped: {},
  };
  const parts: BundleParts = {
    manifest,
    signature: await sign(keys.privateKey, manifestText(manifest)),
    rows: new Map([["camp", rowsText]]),
    files: new Map([["c/f", file]]),
  };
  return { keys, parts };
}

describe("camp bundle", () => {
  it("round-trips rows, BLOBs included", () => {
    const rows = [{ id: "a", b: new Uint8Array([1, 2]), n: null, x: 1.5 }];
    expect(decodeRows(encodeRows(rows))).toEqual(rows);
  });

  it("signs and verifies", async () => {
    const k = await newMoveKeys();
    const sig = await sign(k.privateKey, "hello");
    expect(await verify(k.publicKey, "hello", sig)).toBe(true);
    expect(await verify(k.publicKey, "hellO", sig)).toBe(false);
    expect(await verify((await newMoveKeys()).publicKey, "hello", sig)).toBe(
      false,
    );
  });

  it("parses the move code it formats, origins with ports included", () => {
    const secret = newSecret();
    for (const origin of ["https://camptool.org", "http://localhost:17923"]) {
      expect(
        parseMoveCode(formatMoveCode({ origin, moveId: MOVE_ID, secret })),
      ).toEqual({ origin, moveId: MOVE_ID, secret });
    }
    expect(parseMoveCode("camptool-move:1:nope")).toBeNull();
    expect(
      parseMoveCode(`camptool-move:1:https://x.org/path:${MOVE_ID}:${secret}`),
    ).toBeNull();
  });

  it("packs, unpacks and checks a bundle file", async () => {
    const { keys, parts } = await sample();
    const secret = newSecret();
    const file = await packBundle(parts, secret);
    const back = await unpackBundle(file, secret);
    expect(back.manifest).toEqual(parts.manifest);
    expect(back.rows).toEqual(parts.rows);
    expect(back.files).toEqual(parts.files);
    expect(await checkBundle(back, back.files, keys.publicKey)).toEqual([]);
  });

  it("refuses the wrong code, and notices tampering", async () => {
    const { keys, parts } = await sample();
    const secret = newSecret();
    const file = await packBundle(parts, secret);
    await expect(unpackBundle(file, newSecret())).rejects.toThrow(
      "doesn't open",
    );
    const back = await unpackBundle(file, secret);
    back.rows.set("camp", encodeRows([{ id: "evil" }]));
    back.files.set("c/f", new Uint8Array([0]));
    expect(await checkBundle(back, back.files, keys.publicKey)).toEqual([
      "Rows for camp are damaged.",
      "File c/f is damaged.",
    ]);
    back.manifest.camp.name = "Renamed";
    expect((await checkBundle(back, null, keys.publicKey))[0]).toContain(
      "signature",
    );
  });
});
