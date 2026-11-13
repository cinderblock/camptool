/**
 * Blob host: a directory on disk. The default (firefly, jackson, Docker, dev).
 * See `./blobs.types.ts`.
 */
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { BlobStore } from "./blobs.types";

/**
 * Where the files go. Defaults to `uploads/` next to the database, which on
 * firefly is `/srv/camptool/data/uploads` — a directory that already exists and
 * survives deploys, so standing this up needed no ops change.
 */
export function uploadsRoot(): string {
  const explicit = process.env.UPLOADS_PATH?.trim();
  if (explicit) return explicit;
  const dbPath = process.env.DATABASE_PATH ?? "./data/camptool.db";
  return join(dirname(dbPath), "uploads");
}

/** Keys are app-built, but refuse anything that could climb out of the root. */
function pathFor(key: string): string {
  const parts = key.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new Error(`Bad blob key: ${key}`);
  }
  return join(uploadsRoot(), ...parts);
}

export const blobs: BlobStore = {
  async put(key, bytes) {
    const path = pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, bytes);
  },

  async get(key) {
    const file = Bun.file(pathFor(key));
    if (!(await file.exists())) return null;
    return {
      size: file.size,
      // A Bun file streams from disk: a full-resolution original never has to
      // sit in memory just to be handed to a client.
      stream: () => file.stream(),
      bytes: async () => new Uint8Array(await file.arrayBuffer()),
    };
  },

  async delete(key) {
    await rm(pathFor(key), { force: true });
  },

  async list() {
    const out: { key: string; size: number }[] = [];
    const visit = async (dir: string, prefix: string): Promise<void> => {
      // No uploads directory yet is a normal, empty-deployment state.
      const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        const path = join(dir, item.name);
        const key = prefix ? posix.join(prefix, item.name) : item.name;
        if (item.isDirectory()) await visit(path, key);
        else if (item.isFile())
          out.push({ key, size: (await stat(path)).size });
      }
    };
    await visit(uploadsRoot(), "");
    return out.sort((a, b) => a.key.localeCompare(b.key));
  },
};
