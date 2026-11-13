/**
 * The complete backup (see plans/complete-backup.md).
 *
 * `/export-db` used to hand back only the SQLite file, which meant it was a
 * backup that LIED — every uploaded picture's metadata, none of its bytes.
 * This builds the whole thing: the database snapshot plus every file in the
 * uploads directory, as a streamed `.tar.gz`.
 *
 * The archive is laid out so restoring a Bun host is one command:
 *
 *     tar -xzf camptool-backup-YYYY-MM-DD.tar.gz -C /srv/camptool/data
 *
 * because the entries are `camptool.db` and `uploads/…` — exactly the shape of
 * the data directory they came from. On Cloudflare the database half is
 * `camptool.sql` instead (D1 has no file to copy; see `db/host/d1.ts`), and
 * `uploads/…` holds the R2 bucket's files under the same keys.
 */
import { Duplex } from "node:stream";
import { createGzip } from "node:zlib";
import { db, dbSnapshot } from "../../db/client.server";
import { campImage } from "../../db/schema";
import { blobs } from "./blobs.server";
import { tarHeader, tarPadding, tarTrailer } from "./tar";

/** A stored file destined for the archive. */
type Entry = { archivePath: string; key: string; size: number };

/** Every stored file, as archive-relative paths.
 *
 * The store is listed directly rather than the `camp_image` table: a backup's
 * job is to preserve what EXISTS, including a file whose row was lost. The
 * table is used afterwards only to cross-check and report.
 */
async function walkUploads(): Promise<Entry[]> {
  return (await blobs.list()).map((b) => ({
    archivePath: `uploads/${b.key}`,
    key: b.key,
    size: b.size,
  }));
}

/**
 * A plain-text account of what is in the archive — and, more usefully, of
 * anything that ISN'T. A backup that quietly omits a picture whose file has
 * gone missing is the same failure this whole change exists to fix, so the
 * discrepancy is written into the archive itself.
 */
function manifestText(opts: {
  dbName: string;
  dbBytes: number;
  files: Entry[];
  missing: string[];
  orphans: string[];
  takenAt: string;
}): Uint8Array {
  const totalFileBytes = opts.files.reduce((n, f) => n + f.size, 0);
  const lines = [
    "CampTool backup",
    `Taken: ${opts.takenAt}`,
    "",
    "CONTENTS",
    `  ${opts.dbName.padEnd(13)} ${opts.dbBytes} bytes — the whole database, every camp.`,
    `  uploads/      ${opts.files.length} files, ${totalFileBytes} bytes — every uploaded picture, at full resolution.`,
    "",
    "This is the complete backup: restoring the database file and the uploads",
    "directory together reproduces the deployment's state.",
    "",
    "RESTORE",
    ...(opts.dbName.endsWith(".sql")
      ? [
          "  Taken on Cloudflare: the database is a SQL script, the uploads are",
          "  the R2 bucket's files under the same keys.",
          "  Into D1:          wrangler d1 execute <database> --remote --file camptool.sql",
          "                    then upload uploads/<key> to R2 at <key>.",
          "  Into a Bun host:  sqlite3 /srv/camptool/data/camptool.db < camptool.sql",
          "                    then copy uploads/ to /srv/camptool/data/uploads/.",
        ]
      : [
          "  tar -xzf <this file> -C /srv/camptool/data",
          "",
          "  The entries are named to land exactly where they came from. Stop the",
          "  app first; it opens the database at startup and migrates on boot.",
        ]),
    "",
    "INTEGRITY",
  ];
  if (opts.missing.length === 0 && opts.orphans.length === 0) {
    lines.push("  Every picture in the database has its file, and vice versa.");
  } else {
    if (opts.missing.length > 0) {
      lines.push(
        `  ${opts.missing.length} picture row(s) have NO file on disk. They were`,
        "  already lost before this backup was taken; it cannot restore them:",
        ...opts.missing.map((id) => `    ${id}`),
      );
    }
    if (opts.orphans.length > 0) {
      lines.push(
        `  ${opts.orphans.length} file(s) on disk have no database row. They are`,
        "  included anyway — a backup preserves what exists:",
        ...opts.orphans.map((p) => `    ${p}`),
      );
    }
  }
  lines.push("");
  return new TextEncoder().encode(lines.join("\n"));
}

/** Which picture rows have lost their file, and which files have lost their row. */
async function crossCheck(files: Entry[]): Promise<{
  missing: string[];
  orphans: string[];
}> {
  const rows = await db
    .select({ id: campImage.id, campId: campImage.campId })
    .from(campImage);
  const onDisk = new Set(files.map((f) => f.archivePath));
  const missing = rows
    .filter((r) => !onDisk.has(`uploads/${r.campId}/${r.id}`))
    .map((r) => r.id);
  const known = new Set(rows.map((r) => `uploads/${r.campId}/${r.id}`));
  const orphans = files
    .filter((f) => !known.has(f.archivePath.replace(/\.display$/, "")))
    .map((f) => f.archivePath);
  return { missing, orphans };
}

/**
 * The archive, as a gzip stream.
 *
 * Streamed rather than assembled: the database snapshot is already in memory,
 * but the pictures are full-resolution originals and a camp's archive can be
 * far larger than this process should ever hold at once. Exactly one file is
 * resident at a time.
 */
export async function backupArchive(takenAt: string): Promise<{
  stream: ReadableStream<Uint8Array>;
  filename: string;
}> {
  // Point-in-time, so it is safe to take while the app runs.
  const snapshot = await dbSnapshot();
  const files = await walkUploads();
  const { missing, orphans } = await crossCheck(files);
  const manifest = manifestText({
    dbName: snapshot.name,
    dbBytes: snapshot.bytes.byteLength,
    files,
    missing,
    orphans,
    takenAt,
  });
  const mtime = Math.floor(Date.parse(takenAt) / 1000);

  // One entry per pull() — that is what makes this a stream rather than an
  // in-memory archive with extra steps. Exactly one picture is resident at a
  // time, and the consumer's backpressure decides how fast we read the disk.
  let cursor = -2;
  const tar = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const put = (name: string, bytes: Uint8Array) => {
        // Length comes from the bytes in hand, never from the earlier stat: a
        // file rewritten since the walk would otherwise desync its header from
        // its body and corrupt every entry after it.
        controller.enqueue(tarHeader(name, bytes.byteLength, mtime));
        controller.enqueue(bytes);
        const pad = tarPadding(bytes.byteLength);
        if (pad) controller.enqueue(pad);
      };

      // Manifest first, so `tar -tzf` opens with an explanation of the rest.
      if (cursor === -2) put("MANIFEST.txt", manifest);
      else if (cursor === -1) put(snapshot.name, snapshot.bytes);
      else if (cursor < files.length) {
        const file = files[cursor];
        if (file) {
          const stored = await blobs.get(file.key);
          // A picture deleted between the walk and now is skipped rather than
          // aborting the whole backup — losing one file must not cost the rest.
          if (stored) put(file.archivePath, await stored.bytes());
        }
      } else {
        controller.enqueue(tarTrailer());
        controller.close();
        return;
      }
      cursor++;
    },
  });

  // Gzip via node:zlib rather than the web CompressionStream — Bun 1.3 does not
  // define CompressionStream, so reaching for it here would 500 the route in
  // production. Duplex.toWeb keeps this a real stream either way.
  const gzip = Duplex.toWeb(createGzip()) as unknown as {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  // Deliberately not awaited: the pipe runs as the client drains the response.
  // A failure mid-archive must surface as a broken download rather than an
  // unhandled rejection that takes the process with it.
  tar.pipeTo(gzip.writable).catch((error) => {
    console.error("[backup] archive stream failed", error);
  });

  return {
    stream: gzip.readable,
    filename: `camptool-backup-${takenAt.slice(0, 10)}.tar.gz`,
  };
}
