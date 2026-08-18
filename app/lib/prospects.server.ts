/**
 * Server-side data access for the prospect CRM (see plans/prospects-crm.md).
 * Pairs with the pure vocabulary in prospects.ts.
 *
 * Everything here is officer-gated by its callers; nothing in this file checks
 * permission itself, so don't call it from a loader that hasn't.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client.server";
import {
  campInvite,
  membership,
  prospect,
  prospectHandle,
  prospectInteraction,
  recruitApplication,
  user,
} from "../../db/schema";

/** Display name for an officer, playa name preferred, from a membership id. */
export async function officerNames(
  campId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      id: membership.id,
      name: user.name,
      playa: membership.playaName,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.organizationId, campId));
  return new Map(rows.map((r) => [r.id, r.playa || r.name]));
}

export type ProspectListRow = {
  id: string;
  name: string;
  playaName: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  ownerMembershipId: string | null;
  ownerName: string | null;
  membershipId: string | null;
  nextFollowUpAt: string | null;
  handles: { id: string; kind: string; value: string; label: string | null }[];
  interactionCount: number;
  lastInteractionAt: string | null;
  createdAt: string;
};

/** The list page: every prospect with its handles and log summary. */
export async function loadProspects(
  campId: string,
): Promise<ProspectListRow[]> {
  const rows = await db
    .select()
    .from(prospect)
    .where(eq(prospect.campId, campId))
    .orderBy(desc(prospect.updatedAt));
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const names = await officerNames(campId);

  const handles = await db
    .select()
    .from(prospectHandle)
    .where(inArray(prospectHandle.prospectId, ids));
  const handlesBy = new Map<string, ProspectListRow["handles"]>();
  for (const h of handles) {
    const list = handlesBy.get(h.prospectId) ?? [];
    list.push({ id: h.id, kind: h.kind, value: h.value, label: h.label });
    handlesBy.set(h.prospectId, list);
  }

  // One grouped query rather than a per-row count — a camp courting a hundred
  // people would otherwise fire a hundred queries to render one table.
  const stats = await db
    .select({
      prospectId: prospectInteraction.prospectId,
      count: sql<number>`count(*)`,
      last: sql<number>`max(${prospectInteraction.occurredAt})`,
    })
    .from(prospectInteraction)
    .where(inArray(prospectInteraction.prospectId, ids))
    .groupBy(prospectInteraction.prospectId);
  const statsBy = new Map(stats.map((s) => [s.prospectId, s]));

  return rows.map((r) => {
    const s = statsBy.get(r.id);
    return {
      id: r.id,
      name: r.name,
      playaName: r.playaName,
      email: r.email,
      phone: r.phone,
      status: r.status,
      ownerMembershipId: r.ownerMembershipId,
      ownerName: r.ownerMembershipId
        ? (names.get(r.ownerMembershipId) ?? "Former member")
        : null,
      membershipId: r.membershipId,
      nextFollowUpAt: r.nextFollowUpAt?.toISOString() ?? null,
      handles: handlesBy.get(r.id) ?? [],
      interactionCount: Number(s?.count ?? 0),
      lastInteractionAt: s?.last
        ? new Date(Number(s.last)).toISOString()
        : null,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** One prospect with its full conversation log, newest first. */
export async function loadProspectThread(campId: string, prospectId: string) {
  const [row] = await db
    .select()
    .from(prospect)
    .where(and(eq(prospect.campId, campId), eq(prospect.id, prospectId)))
    .limit(1);
  if (!row) return null;

  const names = await officerNames(campId);
  const handles = await db
    .select()
    .from(prospectHandle)
    .where(eq(prospectHandle.prospectId, prospectId));
  const log = await db
    .select()
    .from(prospectInteraction)
    .where(eq(prospectInteraction.prospectId, prospectId))
    .orderBy(desc(prospectInteraction.occurredAt));

  // The invite issued from this card, if it's still live — so the officer can
  // copy the link again instead of minting a second one.
  const [invite] = await db
    .select({
      id: campInvite.id,
      token: campInvite.token,
      useCount: campInvite.useCount,
      revokedAt: campInvite.revokedAt,
    })
    .from(campInvite)
    .where(
      and(
        eq(campInvite.campId, campId),
        eq(campInvite.prospectId, prospectId),
        isNull(campInvite.revokedAt),
      ),
    )
    .orderBy(desc(campInvite.createdAt))
    .limit(1);

  return {
    prospect: {
      id: row.id,
      name: row.name,
      playaName: row.playaName,
      email: row.email,
      phone: row.phone,
      notes: row.notes,
      status: row.status,
      ownerMembershipId: row.ownerMembershipId,
      ownerName: row.ownerMembershipId
        ? (names.get(row.ownerMembershipId) ?? "Former member")
        : null,
      membershipId: row.membershipId,
      memberName: row.membershipId
        ? (names.get(row.membershipId) ?? "Former member")
        : null,
      recruitApplicationId: row.recruitApplicationId,
      nextFollowUpAt: row.nextFollowUpAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    },
    handles: handles.map((h) => ({
      id: h.id,
      kind: h.kind,
      value: h.value,
      label: h.label,
    })),
    log: log.map((i) => ({
      id: i.id,
      channel: i.channel,
      direction: i.direction,
      occurredAt: i.occurredAt.toISOString(),
      subject: i.subject,
      body: i.body,
      sourceUrl: i.sourceUrl,
      externalRef: i.externalRef,
      counterparty: i.counterparty,
      authorName: i.authorMembershipId
        ? (names.get(i.authorMembershipId) ?? "Former member")
        : "Former member",
    })),
    inviteToken: invite?.token ?? null,
  };
}

/**
 * Find an existing prospect for a person we've just heard from, so two
 * officers don't end up with parallel threads. Matches on email or on any
 * recorded handle — both are exact, because a fuzzy name match that merges two
 * different Jennys is far worse than a duplicate an officer can merge.
 */
export async function findProspectFor(opts: {
  campId: string;
  email?: string | null;
  handles?: string[];
}): Promise<string | null> {
  const email = opts.email?.trim().toLowerCase();
  const handles = (opts.handles ?? []).map((h) => h.trim()).filter(Boolean);
  if (!email && handles.length === 0) return null;

  if (email) {
    const [hit] = await db
      .select({ id: prospect.id })
      .from(prospect)
      .where(
        and(
          eq(prospect.campId, opts.campId),
          sql`lower(${prospect.email}) = ${email}`,
        ),
      )
      .limit(1);
    if (hit) return hit.id;
  }

  if (handles.length) {
    const [hit] = await db
      .select({ prospectId: prospectHandle.prospectId })
      .from(prospectHandle)
      .where(
        and(
          eq(prospectHandle.campId, opts.campId),
          inArray(prospectHandle.value, handles),
        ),
      )
      .limit(1);
    if (hit) return hit.prospectId;
  }
  return null;
}

/**
 * Fold a public application into the prospect pipeline: attach it to the
 * prospect we already had for that person, or start one. Called from the
 * application POST, so it must never throw the submission away — a CRM
 * bookkeeping failure is not a reason to lose a recruit.
 *
 * Cameron's locked decision: one pipeline, so the officer sees the whole
 * relationship in one place rather than an application divorced from the three
 * months of Facebook messages that produced it.
 */
export async function linkApplicationToProspect(opts: {
  campId: string;
  applicationId: string;
  name: string;
  email: string;
  playaName?: string | null;
}): Promise<string | null> {
  try {
    const existing = await findProspectFor({
      campId: opts.campId,
      email: opts.email,
    });
    const now = new Date();

    if (existing) {
      const [row] = await db
        .select({ status: prospect.status })
        .from(prospect)
        .where(eq(prospect.id, existing))
        .limit(1);
      await db
        .update(prospect)
        .set({
          recruitApplicationId: opts.applicationId,
          // Don't drag someone who already joined back to "applied".
          status: row?.status === "joined" ? "joined" : "applied",
          playaName: opts.playaName || undefined,
          updatedAt: now,
        })
        .where(eq(prospect.id, existing));
      await db.insert(prospectInteraction).values({
        id: crypto.randomUUID(),
        campId: opts.campId,
        prospectId: existing,
        channel: "website",
        direction: "inbound",
        occurredAt: now,
        subject: "Submitted the camp application",
        body: null,
      });
      return existing;
    }

    const id = crypto.randomUUID();
    await db.insert(prospect).values({
      id,
      campId: opts.campId,
      name: opts.name,
      playaName: opts.playaName || null,
      email: opts.email,
      status: "applied",
      recruitApplicationId: opts.applicationId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(prospectInteraction).values({
      id: crypto.randomUUID(),
      campId: opts.campId,
      prospectId: id,
      channel: "website",
      direction: "inbound",
      occurredAt: now,
      subject: "Submitted the camp application",
      body: null,
    });
    return id;
  } catch (e) {
    // Never let CRM bookkeeping cost us the application itself.
    console.error("linkApplicationToProspect failed", e);
    return null;
  }
}

/**
 * The person joined. Stamp the membership onto their prospect record so the
 * officers' history follows them in, and log it. Safe to call when there is no
 * prospect — that's the common case.
 */
export async function markProspectJoined(opts: {
  campId: string;
  prospectId: string;
  membershipId: string;
}): Promise<void> {
  try {
    const now = new Date();
    await db
      .update(prospect)
      .set({
        membershipId: opts.membershipId,
        status: "joined",
        nextFollowUpAt: null,
        updatedAt: now,
      })
      .where(
        and(eq(prospect.id, opts.prospectId), eq(prospect.campId, opts.campId)),
      );
    await db.insert(prospectInteraction).values({
      id: crypto.randomUUID(),
      campId: opts.campId,
      prospectId: opts.prospectId,
      channel: "website",
      direction: "inbound",
      occurredAt: now,
      subject: "Joined the camp",
      body: null,
    });
  } catch (e) {
    console.error("markProspectJoined failed", e);
  }
}

/** How many prospects need attention — an overdue follow-up, or nobody has
 * claimed them. Drives the nav badge. */
export async function countProspectsNeedingAttention(
  campId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(prospect)
    .where(
      and(
        eq(prospect.campId, campId),
        inArray(prospect.status, ["lead", "talking", "invited", "applied"]),
        or(
          isNull(prospect.ownerMembershipId),
          sql`${prospect.nextFollowUpAt} is not null and ${prospect.nextFollowUpAt} <= ${Date.now()}`,
        ),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Applications with no prospect yet — the backfill offered on the list page
 * when a camp turns this on with a queue already sitting there. */
export async function unlinkedApplications(campId: string) {
  const linked = await db
    .select({ id: prospect.recruitApplicationId })
    .from(prospect)
    .where(eq(prospect.campId, campId));
  const taken = new Set(linked.map((l) => l.id).filter(Boolean) as string[]);
  const apps = await db
    .select({
      id: recruitApplication.id,
      name: recruitApplication.name,
      email: recruitApplication.email,
      playaName: recruitApplication.playaName,
      status: recruitApplication.status,
      createdAt: recruitApplication.createdAt,
    })
    .from(recruitApplication)
    .where(eq(recruitApplication.campId, campId));
  return apps.filter((a) => !taken.has(a.id));
}
