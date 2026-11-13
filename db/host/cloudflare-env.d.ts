/**
 * The Cloudflare bindings CampTool's Workers build expects (see
 * wrangler.jsonc). Declared here, rather than through the generated
 * `worker-configuration.d.ts`, so the Workers globals never leak into the
 * Bun/DOM type world the rest of the app compiles against.
 */
declare module "cloudflare:workers" {
  import type {
    D1Database,
    R2Bucket,
  } from "@cloudflare/workers-types/index.ts";

  export const env: {
    /** The app database. */
    DB: D1Database;
    /** Uploaded files (pictures, SAP documents). */
    BLOBS: R2Bucket;
  } & Record<string, unknown>;
}
