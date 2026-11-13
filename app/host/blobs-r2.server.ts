/**
 * Blob host: a Cloudflare R2 bucket (the `BLOBS` binding). Selected by the
 * `workerd` import condition. See `./blobs.types.ts`.
 */
import { env } from "cloudflare:workers";
import type { BlobStore } from "./blobs.types";

const bucket = env.BLOBS;

export const blobs: BlobStore = {
  async put(key, bytes) {
    await bucket.put(key, bytes);
  },

  async get(key) {
    const obj = await bucket.get(key);
    if (!obj) return null;
    return {
      size: obj.size,
      stream: () => obj.body as unknown as ReadableStream<Uint8Array>,
      bytes: async () => new Uint8Array(await obj.arrayBuffer()),
    };
  },

  async delete(key) {
    await bucket.delete(key);
  },

  async list() {
    const out: { key: string; size: number }[] = [];
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ cursor, limit: 1000 });
      for (const o of page.objects) out.push({ key: o.key, size: o.size });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  },
};
