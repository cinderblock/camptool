/**
 * Camp wiki — server helpers (see plans/camp-wiki.md). Every function is
 * camp-scoped: the campId argument is the multi-camp invariant, never optional.
 */
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { db } from "../../db/client.server";
import { wikiLink, wikiPage, wikiRevision } from "../../db/schema";
import { featureVisibleTo } from "./features";
import { getFeatureState } from "./features.server";
import { type WikiSubjectType, wikiLinkSlugs, wikiSlug } from "./wiki";

export type WikiPageRow = typeof wikiPage.$inferSelect;

export async function listPages(campId: string) {
  return db
    .select({
      id: wikiPage.id,
      slug: wikiPage.slug,
      title: wikiPage.title,
      body: wikiPage.body,
      updatedAt: wikiPage.updatedAt,
      updatedById: wikiPage.updatedById,
    })
    .from(wikiPage)
    .where(eq(wikiPage.campId, campId))
    .orderBy(desc(wikiPage.updatedAt));
}

export async function getPageBySlug(campId: string, slug: string) {
  const [row] = await db
    .select()
    .from(wikiPage)
    .where(and(eq(wikiPage.campId, campId), eq(wikiPage.slug, slug)))
    .limit(1);
  return row ?? null;
}

/** Slugs of every page in the camp — powers red-links (a `[[link]]` to a page
 * nobody has written yet renders dimmed, with an offer to create it). */
export async function existingSlugs(campId: string): Promise<Set<string>> {
  const rows = await db
    .select({ slug: wikiPage.slug })
    .from(wikiPage)
    .where(eq(wikiPage.campId, campId));
  return new Set(rows.map((r) => r.slug));
}

/**
 * Create a page. Returns the slug, or null when that slug is taken — the
 * unique index is the real guard, this is just the friendly path.
 */
export async function createPage(opts: {
  campId: string;
  title: string;
  body?: string;
  userId: string;
}): Promise<{ id: string; slug: string } | null> {
  const slug = wikiSlug(opts.title);
  if (!slug) return null;
  const existing = await getPageBySlug(opts.campId, slug);
  if (existing) return null;
  const id = crypto.randomUUID();
  await db.insert(wikiPage).values({
    id,
    campId: opts.campId,
    slug,
    title: opts.title.trim(),
    body: opts.body ?? "",
    createdById: opts.userId,
    updatedById: opts.userId,
  });
  return { id, slug };
}

/**
 * Save an edit, snapshotting the PREVIOUS title+body into wiki_revision first.
 * That snapshot is what makes "any member can edit any page" safe: nothing is
 * ever destroyed, and an officer can restore.
 */
export async function savePage(opts: {
  campId: string;
  page: WikiPageRow;
  title: string;
  body: string;
  summary?: string | null;
  userId: string;
}): Promise<void> {
  await db.insert(wikiRevision).values({
    id: crypto.randomUUID(),
    pageId: opts.page.id,
    campId: opts.campId,
    title: opts.page.title,
    body: opts.page.body,
    summary: opts.summary?.trim() || null,
    editedById: opts.userId,
  });
  await db
    .update(wikiPage)
    .set({
      title: opts.title.trim(),
      body: opts.body,
      updatedById: opts.userId,
      updatedAt: new Date(),
    })
    .where(
      and(eq(wikiPage.id, opts.page.id), eq(wikiPage.campId, opts.campId)),
    );
}

export async function pageHistory(campId: string, pageId: string) {
  return db
    .select({
      id: wikiRevision.id,
      title: wikiRevision.title,
      body: wikiRevision.body,
      summary: wikiRevision.summary,
      editedAt: wikiRevision.editedAt,
      editedById: wikiRevision.editedById,
    })
    .from(wikiRevision)
    .where(
      and(eq(wikiRevision.campId, campId), eq(wikiRevision.pageId, pageId)),
    )
    .orderBy(desc(wikiRevision.editedAt));
}

/* ------------------------------------------------------------- subject ties */

export async function subjectsForPage(campId: string, pageId: string) {
  return db
    .select({
      id: wikiLink.id,
      subjectType: wikiLink.subjectType,
      subjectId: wikiLink.subjectId,
    })
    .from(wikiLink)
    .where(and(eq(wikiLink.campId, campId), eq(wikiLink.pageId, pageId)));
}

/** The reverse lookup the map side panel uses: "does this thing have a page?" */
export async function pagesForSubject(
  campId: string,
  subjectType: WikiSubjectType,
  subjectId: string,
) {
  return db
    .select({
      id: wikiPage.id,
      slug: wikiPage.slug,
      title: wikiPage.title,
    })
    .from(wikiLink)
    .innerJoin(wikiPage, eq(wikiPage.id, wikiLink.pageId))
    .where(
      and(
        eq(wikiLink.campId, campId),
        eq(wikiLink.subjectType, subjectType),
        eq(wikiLink.subjectId, subjectId),
      ),
    );
}

/**
 * Page ties for MANY subjects at once — the map loads every placed object's
 * kind in one query rather than one per structure.
 */
export async function pagesForSubjects(
  campId: string,
  subjectType: WikiSubjectType,
  subjectIds: string[],
): Promise<Map<string, { slug: string; title: string }>> {
  if (subjectIds.length === 0) return new Map();
  const rows = await db
    .select({
      subjectId: wikiLink.subjectId,
      slug: wikiPage.slug,
      title: wikiPage.title,
    })
    .from(wikiLink)
    .innerJoin(wikiPage, eq(wikiPage.id, wikiLink.pageId))
    .where(
      and(
        eq(wikiLink.campId, campId),
        eq(wikiLink.subjectType, subjectType),
        inArray(wikiLink.subjectId, subjectIds),
      ),
    );
  return new Map(
    rows.map((r) => [r.subjectId, { slug: r.slug, title: r.title }]),
  );
}

export async function addSubjectLink(opts: {
  campId: string;
  pageId: string;
  subjectType: WikiSubjectType;
  subjectId: string;
  userId: string;
}): Promise<void> {
  await db
    .insert(wikiLink)
    .values({
      id: crypto.randomUUID(),
      campId: opts.campId,
      pageId: opts.pageId,
      subjectType: opts.subjectType,
      subjectId: opts.subjectId,
      createdById: opts.userId,
    })
    .onConflictDoNothing();
}

export async function removeSubjectLink(
  campId: string,
  linkId: string,
): Promise<void> {
  await db
    .delete(wikiLink)
    .where(and(eq(wikiLink.campId, campId), eq(wikiLink.id, linkId)));
}

/**
 * Wiki ties for everything on the map, in two queries. Returns empties (and
 * `enabled: false`) when this camp hasn't turned the wiki on, so the map can
 * call this unconditionally and render nothing.
 *
 * `byKind` is the one that matters: a page tied to the Sierpinski pyramid KIND
 * shows on every placed instance, this year and every year after. `byObject`
 * covers the "this specific one is different" case.
 */
export async function wikiTiesFor(
  active: { camp: { id: string }; membership: { role: string } },
  objects: Array<{ id: string; kind: string }>,
): Promise<{
  enabled: boolean;
  byKind: Record<string, { slug: string; title: string }>;
  byObject: Record<string, { slug: string; title: string }>;
}> {
  const campId = active.camp.id;
  const state = await getFeatureState(campId, "wiki");
  if (!featureVisibleTo(state, active.membership.role)) {
    return { enabled: false, byKind: {}, byObject: {} };
  }
  const kinds = [...new Set(objects.map((o) => o.kind))];
  const [byKind, byObject] = await Promise.all([
    pagesForSubjects(campId, "structure_kind", kinds),
    pagesForSubjects(
      campId,
      "map_object",
      objects.map((o) => o.id),
    ),
  ]);
  return {
    enabled: true,
    byKind: Object.fromEntries(byKind),
    byObject: Object.fromEntries(byObject),
  };
}

/* ---------------------------------------------------------------- backlinks */

/**
 * Pages whose body contains a `[[…]]` link resolving to `slug`. Narrowed in SQL
 * to bodies that contain "[[" at all, then parsed properly — a camp has dozens
 * of pages, not millions, and parsing is the only way to honour `[[Title|label]]`
 * and title-vs-slug spelling.
 */
export async function backlinksTo(
  campId: string,
  slug: string,
  selfId: string,
) {
  const candidates = await db
    .select({
      id: wikiPage.id,
      slug: wikiPage.slug,
      title: wikiPage.title,
      body: wikiPage.body,
    })
    .from(wikiPage)
    .where(and(eq(wikiPage.campId, campId), like(wikiPage.body, "%[[%")));
  return candidates
    .filter((p) => p.id !== selfId && wikiLinkSlugs(p.body).includes(slug))
    .map(({ id, slug: s, title }) => ({ id, slug: s, title }));
}

/** Simple title/body search for the index page. */
export async function searchPages(campId: string, q: string) {
  const term = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  return db
    .select({
      id: wikiPage.id,
      slug: wikiPage.slug,
      title: wikiPage.title,
      body: wikiPage.body,
      updatedAt: wikiPage.updatedAt,
    })
    .from(wikiPage)
    .where(
      and(
        eq(wikiPage.campId, campId),
        or(like(wikiPage.title, term), like(wikiPage.body, term)),
      ),
    )
    .orderBy(desc(wikiPage.updatedAt));
}
