/**
 * Uploaded files, on whichever host this build runs on. See
 * `app/host/blobs.types.ts`.
 */
export { blobs } from "#host/blobs";
export type { BlobStore, StoredBlob } from "~/host/blobs.types";

/** `<camp>/<image>` or `<camp>/<image>.display`. */
export function imageKey(
  campId: string,
  id: string,
  variant: "full" | "display",
): string {
  return `${campId}/${variant === "full" ? id : `${id}.display`}`;
}

/** `<camp>/sap/<document>`: a stored vendor PDF. */
export function sapDocumentKey(campId: string, documentId: string): string {
  return `${campId}/sap/${documentId}`;
}
