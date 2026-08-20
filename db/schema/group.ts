/**
 * Social groups — who belongs with whom.
 *
 * These are **relationships, not teams**: a family, a couple, housemates, the
 * friends somebody brought along, the people who have camped together for a
 * decade. A camp of sixty is not a flat list of sixty, and it is not an org
 * chart either — it is a handful of families and friendships that happen to
 * share a lot. These tables let that be said out loud so the roster and the
 * directory read the way the camp actually thinks (`plans/social-groups.md`).
 *
 * Work crews are a different shape and are not this: what a camp *does*
 * together lives on the schedule as shifts and roles, where a job has hours and
 * a headcount. If a group starts being used to mean "the people rostered onto
 * the kitchen", that belongs in `db/schema/schedule.ts` instead.
 *
 * Three things this deliberately is NOT:
 *
 *  - **Not a permission.** Nothing anywhere grants authority because two people
 *    share a group. Authority over another person's tickets or passes comes
 *    from the party link (`attendee.host_membership_id`, see
 *    `plans/party-member-links.md`) or from a role, and it stays there. A group
 *    that granted reach would be a party, and a party already exists.
 *
 *  - **Not who someone is camping with.** That is the party link too, it is
 *    per-year, and it drives real logistics (tent, arrival, tickets). A family
 *    outlives any one year and may not even be on playa together; the two
 *    overlap constantly but they are different claims about the world.
 *
 *  - **Not the invite tree.** Who invited whom is a fact, already recorded on
 *    `membership.invited_by_membership_id`. A social group is a judgement, and
 *    the two drift apart the moment someone is invited by an officer they
 *    barely know. The tree can *suggest* a group; it never defines one.
 *
 * Camp-scoped rather than edition-scoped: a social group outlives one year.
 */
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { camp, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const campGroup = sqliteTable(
  "camp_group",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // Groups nest: a household inside the wider family, a couple inside a
    // household. Structural only — being in a child does NOT make you a member
    // of its parent; a parent's own list is its own list, and the UI shows
    // rolled-up counts beside direct ones rather than inventing membership
    // nobody declared.
    //
    // SET NULL, not cascade: deleting a parent must never take its children's
    // members with it. Orphaned children resurface as roots.
    parentGroupId: text("parent_group_id").references(
      (): AnySQLiteColumn => campGroup.id,
      { onDelete: "set null" },
    ),
    // Mantine palette name (e.g. "grape"), used for the section chip and the
    // map tint. Null = the fallback tint derived from the name.
    color: text("color"),
    // Who started it. Set null rather than cascade: the group outlives the
    // person who created it, exactly like the camp's other authored rows.
    createdByMembershipId: text("created_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  // Names are the handle people use to talk about a group, so two groups called
  // "The Riveras" in one camp would defeat the purpose. Compared case-insensitively.
  (t) => [uniqueIndex("camp_group_name").on(t.campId, sql`lower(${t.name})`)],
);

export const campGroupMember = sqliteTable(
  "camp_group_member",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => campGroup.id, { onDelete: "cascade" }),
    membershipId: text("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    addedByMembershipId: text("added_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    uniqueIndex("camp_group_member_unique").on(t.groupId, t.membershipId),
  ],
);
