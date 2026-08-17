/**
 * Camp FAQ — server helpers (see plans/camp-faq.md). Every function is
 * camp-scoped: the campId argument is the multi-camp invariant, never optional.
 */
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.server";
import { faqCategory, faqEntry } from "../../db/schema";
import { type FaqStatus, faqSlug } from "./faq";
import { featureVisibleTo } from "./features";
import { getFeatureState } from "./features.server";

export type FaqEntryRow = typeof faqEntry.$inferSelect;
export type FaqCategoryRow = typeof faqCategory.$inferSelect;

/* ------------------------------------------------------------- categories */

export async function listCategories(
  campId: string,
): Promise<FaqCategoryRow[]> {
  return db
    .select()
    .from(faqCategory)
    .where(eq(faqCategory.campId, campId))
    .orderBy(asc(faqCategory.position), asc(faqCategory.name));
}

export async function createCategory(opts: {
  campId: string;
  name: string;
  userId: string;
}): Promise<{ id: string } | null> {
  const name = opts.name.trim();
  const base = faqSlug(name);
  if (!name || !base) return null;
  const existing = await listCategories(opts.campId);
  if (existing.some((c) => c.slug === base)) return null;
  const id = crypto.randomUUID();
  await db.insert(faqCategory).values({
    id,
    campId: opts.campId,
    name,
    slug: base,
    position: existing.length,
    createdById: opts.userId,
  });
  return { id };
}

/** Renaming keeps the slug: `/faq?category=money` and any link that used it
 * must survive an officer tidying up the wording. */
export async function renameCategory(
  campId: string,
  id: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await db
    .update(faqCategory)
    .set({ name: trimmed })
    .where(and(eq(faqCategory.campId, campId), eq(faqCategory.id, id)));
}

/** Entries filed under it survive — the FK is ON DELETE SET NULL, so they fall
 * back into General rather than vanishing with the bucket. */
export async function deleteCategory(
  campId: string,
  id: string,
): Promise<void> {
  await db
    .delete(faqCategory)
    .where(and(eq(faqCategory.campId, campId), eq(faqCategory.id, id)));
}

export async function moveCategory(
  campId: string,
  id: string,
  direction: "up" | "down",
): Promise<void> {
  const all = await listCategories(campId);
  const index = all.findIndex((c) => c.id === id);
  const target = direction === "up" ? index - 1 : index + 1;
  const self = all[index];
  const other = all[target];
  if (index < 0 || !self || !other) return;
  // Positions are rewritten from the sorted order rather than swapped blindly,
  // so a camp whose rows all share position 0 still reorders correctly.
  await db.transaction(async (tx) => {
    const order = [...all];
    order[index] = other;
    order[target] = self;
    for (const [i, c] of order.entries()) {
      await tx
        .update(faqCategory)
        .set({ position: i })
        .where(and(eq(faqCategory.campId, campId), eq(faqCategory.id, c.id)));
    }
  });
}

/* ---------------------------------------------------------------- entries */

export async function listEntries(
  campId: string,
  statuses: FaqStatus[],
): Promise<FaqEntryRow[]> {
  if (statuses.length === 0) return [];
  return db
    .select()
    .from(faqEntry)
    .where(and(eq(faqEntry.campId, campId), inArray(faqEntry.status, statuses)))
    .orderBy(asc(faqEntry.position), asc(faqEntry.createdAt));
}

export async function getEntryBySlug(
  campId: string,
  slug: string,
): Promise<FaqEntryRow | null> {
  const [row] = await db
    .select()
    .from(faqEntry)
    .where(and(eq(faqEntry.campId, campId), eq(faqEntry.slug, slug)))
    .limit(1);
  return row ?? null;
}

export async function getEntryById(
  campId: string,
  id: string,
): Promise<FaqEntryRow | null> {
  const [row] = await db
    .select()
    .from(faqEntry)
    .where(and(eq(faqEntry.campId, campId), eq(faqEntry.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * A slug nobody else in this camp is using. Questions repeat ("What do I
 * bring?" under two categories), and the address is frozen once assigned, so
 * the disambiguating suffix is permanent and has to be cheap.
 */
async function uniqueSlug(campId: string, question: string): Promise<string> {
  const base = faqSlug(question) || "question";
  const rows = await db
    .select({ slug: faqEntry.slug })
    .from(faqEntry)
    .where(eq(faqEntry.campId, campId));
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Append to the end of whichever bucket the entry lands in. */
async function nextPosition(
  campId: string,
  categoryId: string | null,
): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${faqEntry.position})` })
    .from(faqEntry)
    .where(
      and(
        eq(faqEntry.campId, campId),
        categoryId
          ? eq(faqEntry.categoryId, categoryId)
          : isNull(faqEntry.categoryId),
      ),
    );
  return (row?.max ?? -1) + 1;
}

export async function createEntry(opts: {
  campId: string;
  question: string;
  answer?: string;
  categoryId?: string | null;
  status: FaqStatus;
  userId: string;
  /** Set for a member-submitted question; the officer path leaves it off. */
  asked?: boolean;
}): Promise<{ id: string; slug: string } | null> {
  const question = opts.question.trim();
  if (!question) return null;
  const categoryId = opts.categoryId ?? null;
  const slug = await uniqueSlug(opts.campId, question);
  const id = crypto.randomUUID();
  const nowDate = new Date();
  await db.insert(faqEntry).values({
    id,
    campId: opts.campId,
    slug,
    question,
    answer: opts.answer ?? "",
    status: opts.status,
    categoryId,
    position: await nextPosition(opts.campId, categoryId),
    askedById: opts.asked ? opts.userId : null,
    askedAt: opts.asked ? nowDate : null,
    answeredById:
      opts.status === "published" && !opts.asked ? opts.userId : null,
    answeredAt: opts.status === "published" && !opts.asked ? nowDate : null,
    createdById: opts.userId,
    updatedById: opts.userId,
  });
  return { id, slug };
}

/**
 * Officer edit. The slug is deliberately NOT recomputed from a re-worded
 * question — every `[[/faq/…]]` link already written would break.
 */
export async function updateEntry(opts: {
  campId: string;
  entry: FaqEntryRow;
  question: string;
  answer: string;
  categoryId: string | null;
  status: FaqStatus;
  userId: string;
}): Promise<void> {
  const question = opts.question.trim();
  if (!question) return;
  // Moving between buckets appends rather than colliding with someone else's
  // position number in the destination.
  const moved = (opts.entry.categoryId ?? null) !== opts.categoryId;
  const publishing =
    opts.status === "published" && opts.entry.status !== "published";
  await db
    .update(faqEntry)
    .set({
      question,
      answer: opts.answer,
      categoryId: opts.categoryId,
      status: opts.status,
      ...(moved
        ? { position: await nextPosition(opts.campId, opts.categoryId) }
        : {}),
      ...(publishing
        ? { answeredById: opts.userId, answeredAt: new Date() }
        : {}),
      updatedById: opts.userId,
      updatedAt: new Date(),
    })
    .where(
      and(eq(faqEntry.campId, opts.campId), eq(faqEntry.id, opts.entry.id)),
    );
}

export async function setEntryStatus(
  campId: string,
  id: string,
  status: FaqStatus,
  userId: string,
): Promise<void> {
  await db
    .update(faqEntry)
    .set({ status, updatedById: userId, updatedAt: new Date() })
    .where(and(eq(faqEntry.campId, campId), eq(faqEntry.id, id)));
}

export async function deleteEntry(campId: string, id: string): Promise<void> {
  await db
    .delete(faqEntry)
    .where(and(eq(faqEntry.campId, campId), eq(faqEntry.id, id)));
}

/** Reorder within the entry's own category, among published entries only —
 * pending and archived rows don't appear in the list being reordered. */
export async function moveEntry(
  campId: string,
  id: string,
  direction: "up" | "down",
): Promise<void> {
  const entry = await getEntryById(campId, id);
  if (!entry) return;
  const siblings = await db
    .select({ id: faqEntry.id, position: faqEntry.position })
    .from(faqEntry)
    .where(
      and(
        eq(faqEntry.campId, campId),
        eq(faqEntry.status, "published"),
        entry.categoryId
          ? eq(faqEntry.categoryId, entry.categoryId)
          : isNull(faqEntry.categoryId),
      ),
    )
    .orderBy(asc(faqEntry.position), asc(faqEntry.createdAt));
  const index = siblings.findIndex((s) => s.id === id);
  const target = direction === "up" ? index - 1 : index + 1;
  const self = siblings[index];
  const other = siblings[target];
  if (index < 0 || !self || !other) return;
  await db.transaction(async (tx) => {
    const order = [...siblings];
    order[index] = other;
    order[target] = self;
    for (const [i, s] of order.entries()) {
      await tx
        .update(faqEntry)
        .set({ position: i })
        .where(and(eq(faqEntry.campId, campId), eq(faqEntry.id, s.id)));
    }
  });
}

/** Officer nav badge: how many questions are waiting on an answer. */
export async function countPendingEntries(campId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(faqEntry)
    .where(and(eq(faqEntry.campId, campId), eq(faqEntry.status, "pending")));
  return row?.n ?? 0;
}

/**
 * Published answers as link targets, for the WIKI editor's "Insert a link to…"
 * picker. Returns nothing (rather than throwing) when this camp hasn't turned
 * the FAQ on, so the wiki loader can call it unconditionally.
 */
export async function faqLinkTargets(active: {
  camp: { id: string };
  membership: { role: string };
}): Promise<Array<{ path: string; label: string }>> {
  const state = await getFeatureState(active.camp.id, "faq");
  if (!featureVisibleTo(state, active.membership.role)) return [];
  const rows = await db
    .select({ slug: faqEntry.slug, question: faqEntry.question })
    .from(faqEntry)
    .where(
      and(
        eq(faqEntry.campId, active.camp.id),
        eq(faqEntry.status, "published"),
      ),
    )
    .orderBy(asc(faqEntry.position));
  return rows.map((r) => ({ path: `/faq/${r.slug}`, label: r.question }));
}
