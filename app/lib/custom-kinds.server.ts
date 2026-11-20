/**
 * Camp-defined structure kinds: server helpers (see plans/custom-structures.md).
 * Every function takes the camp id; a camp only ever loads its own kinds.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db/client.server";
import { structureKind } from "../../db/schema";
import {
  type CustomKindData,
  customKindRegistry,
  toCustomKindData,
} from "./custom-kinds";
import type { KindRegistry } from "./structures";

/** The camp's own kinds, archived ones included (they still draw). */
export async function loadCustomKinds(
  campId: string,
): Promise<CustomKindData[]> {
  const rows = await db
    .select()
    .from(structureKind)
    .where(eq(structureKind.campId, campId));
  return rows.map(toCustomKindData);
}

/** The camp's full palette, for loaders and actions that resolve or validate
 * kinds. */
export async function loadKindRegistry(campId: string): Promise<KindRegistry> {
  return customKindRegistry(await loadCustomKinds(campId));
}
