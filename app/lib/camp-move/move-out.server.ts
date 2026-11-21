/**
 * A camp leaving this install (plans/camp-portability.md, "Overview" and
 * "Freezing and deleting on the source").
 *
 *   start   → move code issued, camp frozen (read-only)
 *   pull    → the target fetches the bundle and files with the code
 *   done    → the target says it has the camp: this install deletes the camp's
 *             data, then forwards its links and vouches for its people's
 *             sign-ins until the window ends
 *   cancel  → unfrozen, code dead
 *
 * Server-only.
 */
import { Buffer } from "node:buffer";
import { and, desc, eq, gt, inArray, isNotNull, lt, or } from "drizzle-orm";
import { data } from "react-router";
import { db } from "../../../db/client.server";
import { campMoveOut, membership, superAdmin, user } from "../../../db/schema";
import { deleteCamp } from "../camp-admin.server";
import {
  formatMoveCode,
  type Manifest,
  manifestText,
  newMoveKeys,
  newSecret,
  secretHash,
  sign,
} from "./bundle";
import { type CampExport, exportCamp } from "./export.server";

/** An unused move code stops working after this long. */
export const CODE_DAYS = 7;
/** Forwarding and the login bridge, after the move (decision 7). */
export const WINDOW_DAYS = 365;

export type MoveOut = typeof campMoveOut.$inferSelect;

/** D1 binds at most 100 parameters per statement. */
function chunks<T>(list: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// --- Sealing secrets at rest (AES-GCM, key from BETTER_AUTH_SECRET) ---

async function sealKey(): Promise<CryptoKey> {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET isn't set");
  const raw = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`camptool-move-seal:${secret}`),
  );
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function seal(text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await sealKey(),
    new TextEncoder().encode(text),
  );
  return `${Buffer.from(iv).toString("base64url")}.${Buffer.from(ct).toString("base64url")}`;
}

export async function unseal(sealed: string): Promise<string> {
  const [iv, ct] = sealed.split(".");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(iv ?? "", "base64url") },
    await sealKey(),
    Buffer.from(ct ?? "", "base64url"),
  );
  return new TextDecoder().decode(pt);
}

// --- Lifecycle ---

/** The camp's move in progress (code issued, not yet done), if any. While one
 * is open the camp is frozen. An expired code no longer freezes anything. */
export async function openMoveFor(
  campId: string,
  now = new Date(),
): Promise<MoveOut | null> {
  const [row] = await db
    .select()
    .from(campMoveOut)
    .where(
      and(
        eq(campMoveOut.campId, campId),
        eq(campMoveOut.state, "open"),
        gt(campMoveOut.codeExpiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findMoveOut(id: string): Promise<MoveOut | null> {
  const [row] = await db
    .select()
    .from(campMoveOut)
    .where(eq(campMoveOut.id, id))
    .limit(1);
  return row ?? null;
}

export const MOVING_MESSAGE =
  "This camp is moving to another CampTool site, so it's read-only until the move is finished or cancelled.";

/** Refuse a write to a camp that's moving. For the few camp writes that don't
 * go through `resolveActiveCamp` (joining by invite, applying). */
export async function assertNotMoving(campId: string): Promise<void> {
  if (await openMoveFor(campId)) {
    throw data({ error: MOVING_MESSAGE }, { status: 423 });
  }
}

/** Start moving `campId` out. Freezes the camp; returns the move code. */
export async function startMoveOut(opts: {
  campId: string;
  campSlug: string | null;
  campName: string;
  userId: string;
  origin: string;
  now?: Date;
}): Promise<{ id: string; code: string }> {
  const now = opts.now ?? new Date();
  if (await openMoveFor(opts.campId, now)) {
    throw new Error("This camp is already moving.");
  }
  const id = crypto.randomUUID();
  const secret = newSecret();
  const keys = await newMoveKeys();
  await db.insert(campMoveOut).values({
    id,
    campId: opts.campId,
    campSlug: opts.campSlug,
    campName: opts.campName,
    state: "open",
    secretHash: await secretHash(secret),
    secretSealed: await seal(secret),
    publicKey: keys.publicKey,
    privateKey: await seal(keys.privateKey),
    createdByUserId: opts.userId,
    createdAt: now,
    codeExpiresAt: new Date(now.getTime() + CODE_DAYS * 86_400_000),
  });
  return {
    id,
    code: formatMoveCode({ origin: opts.origin, moveId: id, secret }),
  };
}

/** The code again, for the camp admin who started the move. */
export async function moveCodeOf(row: MoveOut, origin: string) {
  return formatMoveCode({
    origin,
    moveId: row.id,
    secret: await unseal(row.secretSealed),
  });
}

export async function cancelMoveOut(id: string): Promise<void> {
  await db
    .update(campMoveOut)
    .set({ state: "cancelled" })
    .where(and(eq(campMoveOut.id, id), eq(campMoveOut.state, "open")));
}

/**
 * The open move a pull request is for, or null. The bearer is the hash of the
 * code's secret; compared in constant time.
 */
export async function authorizePull(
  id: string,
  bearer: string | null,
  now = new Date(),
): Promise<MoveOut | null> {
  if (!bearer) return null;
  const row = await findMoveOut(id);
  if (row?.state !== "open" || !row.campId) return null;
  if (row.codeExpiresAt.getTime() <= now.getTime()) return null;
  const a = Buffer.from(bearer);
  const b = Buffer.from(row.secretHash);
  if (a.length !== b.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0 ? row : null;
}

export type SignedBundle = {
  manifest: Manifest;
  signature: string;
  rows: Record<string, string>;
  people: string[];
};

/** The camp's bundle for this move, signed with its key. Deterministic for a
 * frozen camp, so a retried pull gets the same bytes. */
export async function signedBundle(row: MoveOut): Promise<SignedBundle> {
  if (!row.campId) throw new Error("The camp's data is gone.");
  const out: CampExport = await exportCamp(row.campId, {
    createdAt: row.createdAt.getTime(),
  });
  const manifest: Manifest = {
    ...out.manifest,
    move: { id: row.id, publicKey: row.publicKey },
  };
  return {
    manifest,
    signature: await sign(await unseal(row.privateKey), manifestText(manifest)),
    rows: Object.fromEntries(out.rows),
    people: out.people,
  };
}

/**
 * The target has the camp. Record where it went, delete its data here (the
 * target checked every row and file before saying so), and start the window.
 */
export async function completeMoveOut(
  row: MoveOut,
  target: { origin: string; campUrl: string },
  now = new Date(),
): Promise<void> {
  if (row.state !== "open") throw new Error("This move isn't open.");
  const people = row.campId ? (await signedBundle(row)).people : [];
  await db
    .update(campMoveOut)
    .set({
      state: "done",
      targetOrigin: target.origin,
      targetCampUrl: target.campUrl,
      doneAt: now,
      windowEndsAt: new Date(now.getTime() + WINDOW_DAYS * 86_400_000),
      people: JSON.stringify(people),
    })
    .where(and(eq(campMoveOut.id, row.id), eq(campMoveOut.state, "open")));
  if (row.campId) {
    await deleteCamp(row.campId);
    await db
      .update(campMoveOut)
      .set({ dataDeletedAt: now })
      .where(eq(campMoveOut.id, row.id));
  }
}

/** Moves whose forwarding and login bridge are running. */
export async function liveMovesOut(now = new Date()): Promise<MoveOut[]> {
  return db
    .select()
    .from(campMoveOut)
    .where(
      and(eq(campMoveOut.state, "done"), gt(campMoveOut.windowEndsAt, now)),
    )
    .orderBy(desc(campMoveOut.doneAt));
}

/** The live move whose old camp slug this is, if any. */
export async function liveMoveBySlug(
  slug: string,
  now = new Date(),
): Promise<MoveOut | null> {
  const [row] = await db
    .select()
    .from(campMoveOut)
    .where(
      and(
        eq(campMoveOut.campSlug, slug),
        eq(campMoveOut.state, "done"),
        gt(campMoveOut.windowEndsAt, now),
      ),
    )
    .orderBy(desc(campMoveOut.doneAt))
    .limit(1);
  return row ?? null;
}

export const peopleOf = (row: MoveOut): string[] => {
  try {
    const v = JSON.parse(row.people ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/**
 * Close moves whose window is over (decision 8): forwarding and the bridge
 * stop, and the moved people's accounts here go if they're left in no camp
 * and aren't site admins. Cheap when there's nothing to do; called lazily.
 */
export async function endExpiredMoves(now = new Date()): Promise<number> {
  const ended = await db
    .select()
    .from(campMoveOut)
    .where(
      or(
        and(eq(campMoveOut.state, "done"), lt(campMoveOut.windowEndsAt, now)),
        and(eq(campMoveOut.state, "open"), lt(campMoveOut.codeExpiresAt, now)),
      ),
    );
  for (const row of ended) {
    await db
      .update(campMoveOut)
      .set({ state: row.state === "open" ? "cancelled" : "ended" })
      .where(eq(campMoveOut.id, row.id));
    if (row.state !== "done") continue;
    const ids = peopleOf(row);
    if (!ids.length) continue;
    const keep = new Set<string>();
    for (const part of chunks(ids)) {
      for (const r of [
        ...(await db
          .select({ id: membership.userId })
          .from(membership)
          .where(inArray(membership.userId, part))),
        ...(await db
          .select({ id: superAdmin.userId })
          .from(superAdmin)
          .where(inArray(superAdmin.userId, part))),
      ]) {
        keep.add(r.id);
      }
    }
    // Someone still mid-move elsewhere (another live move lists them) stays.
    for (const other of await liveMovesOut(now)) {
      for (const id of peopleOf(other)) keep.add(id);
    }
    const gone = ids.filter((id) => !keep.has(id));
    for (const part of chunks(gone)) {
      await db.delete(user).where(inArray(user.id, part));
    }
  }
  return ended.length;
}

/** Every move out, newest first, for Site admin. */
export async function listMovesOut(): Promise<MoveOut[]> {
  return db
    .select()
    .from(campMoveOut)
    .where(isNotNull(campMoveOut.id))
    .orderBy(desc(campMoveOut.createdAt));
}
