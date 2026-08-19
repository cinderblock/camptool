/**
 * Social groups — the camp's own idea of who belongs with whom.
 *
 * A camp of sixty is not a flat list of sixty: it is the fire crew, the Santa
 * Cruz carpool, the people who came because Albert asked them. These tables let
 * that be said out loud so the roster and the directory can be read the way the
 * camp actually thinks (see `plans/social-groups.md`).
 *
 * Two things this deliberately is NOT:
 *
 *  - **Not a permission.** Nothing anywhere grants authority because two people
 *    share a group. Authority over another person's tickets or passes comes
 *    from the party link (`attendee.host_membership_id`, see
 *    `plans/party-member-links.md`) or from a role, and it stays there. A group
 *    that granted reach would be a party, and a party already exists.
 *  - **Not the invite tree.** Who invited whom is a fact, already recorded on
 *    `membership.invited_by_membership_id`. A social group is a judgement, and
 *    the two drift apart the moment someone is invited by an officer they
 *    barely know. The tree can *suggest* a group; it never defines one.
 *
 * Camp-scoped rather than edition-scoped: a social group outlives one year.
 */
import { sql } from "drizzle-orm";
import {
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
  // "Fire crew" in one camp would defeat the purpose. Compared case-insensitively.
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
