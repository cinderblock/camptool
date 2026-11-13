/**
 * Where uploaded files live (pictures, SAP order PDFs), host by host
 * (plans/hosting-other-camps.md). Picked at build time through the
 * `#host/blobs` import in package.json: a directory on disk by default, an R2
 * bucket on Cloudflare. App code imports `blobs` from `~/lib/blobs.server`.
 *
 * Keys are `/`-separated paths, always built by the app from a camp id and a
 * row id, never from anything a user typed: `<camp>/<image>`,
 * `<camp>/<image>.display`, `<camp>/sap/<document>`. On disk they are the
 * paths under the uploads directory, so the layout predates this interface.
 */
export type StoredBlob = {
  size: number;
  /** The bytes as a stream, for a `Response`. Read it or `bytes()`, once. */
  stream(): ReadableStream<Uint8Array>;
  /** The whole file in memory. */
  bytes(): Promise<Uint8Array>;
};

export type BlobStore = {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Null when there's no such file. */
  get(key: string): Promise<StoredBlob | null>;
  /** No error when it's already gone. */
  delete(key: string): Promise<void>;
  /** Every stored file, sorted by key. For the complete backup. */
  list(): Promise<{ key: string; size: number }[]>;
};
