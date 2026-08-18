/**
 * Prospects — the officer CRM for people the camp is talking to but who are not
 * (yet) members. See plans/prospects-crm.md.
 *
 * CAMP-scoped, deliberately NOT edition-scoped: a conversation that starts in
 * one year's off-season and lands the person in the next year's camp is one
 * conversation, not two.
 *
 * Why this isn't `recruit_application`: an application is the artifact of a
 * submitted form, with a name and an email because the form demanded them. A
 * prospect is frequently nothing but "Jenny from the Facebook thread" — no
 * email, no account, no form. `name` is the only thing required.
 *
 * Why it isn't a `membership` with role=recruit: a membership needs a `user`,
 * and a prospect has no account. The two are linked, not merged: once they
 * join, `prospect.membership_id` points at the account and the conversation
 * history follows them (Cameron's locked decision — the log follows the
 * person).
 *
 *   prospect              the person
 *   prospect_handle       where to reach them (facebook, discord, email, …)
 *   prospect_interaction  the log: one row per conversation, either direction
 *
 * Officer-only everywhere. This holds candid notes about people who have not
 * consented to anything, so it gets no public surface and no member surface —
 * see the plan's "Things not to do".
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { camp, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

/**
 * Where a prospect sits in the funnel. Two distinct ways to end at "no",
 * because which side walked away is exactly what an officer wants to know
 * before someone re-opens the conversation next year.
 */
export const PROSPECT_STATUSES = [
  "lead", // someone mentioned them / we spotted them; nobody has talked yet
  "talking", // an actual conversation is happening
  "invited", // we sent them an invite link
  "applied", // they submitted the public application
  "joined", // they have a membership now
  "passed", // we decided no
  "declined", // they decided no
  "stale", // went quiet; kept so we don't re-litigate from scratch
] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

/** Where an interaction happened / where a handle lives. */
export const PROSPECT_CHANNELS = [
  "facebook",
  "instagram",
  "discord",
  "email",
  "sms",
  "phone",
  "signal",
  "telegram",
  "in_person",
  "website",
  "other",
] as const;
export type ProspectChannel = (typeof PROSPECT_CHANNELS)[number];

export const prospect = sqliteTable(
  "prospect",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    // The only required field. Free text on purpose — "Jenny (FB, red hair)"
    // is a legitimate value when that is genuinely all anyone knows.
    name: text("name").notNull(),
    playaName: text("playa_name"),
    email: text("email"),
    phone: text("phone"),
    // A running summary an officer maintains, distinct from the interaction
    // log: "wants to cook, has an RV, nervous about the heat". Wiki markup.
    notes: text("notes"),
    status: text("status").notNull().default("lead"),
    // The officer shepherding them. NULL = unclaimed, which the list surfaces
    // as its own bucket — an unclaimed prospect is how people get dropped.
    ownerMembershipId: text("owner_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    // "Come back to this on…". The one field that makes this a CRM rather than
    // a pile of notes; the nav badge counts the ones that are due.
    nextFollowUpAt: integer("next_follow_up_at", { mode: "timestamp_ms" }),
    // Set once they have an account, which is what makes the history follow
    // them. Not unique: a merge can transiently produce two rows pointing at
    // the same membership, and merging is the fix, not a constraint violation.
    membershipId: text("membership_id").references(() => membership.id, {
      onDelete: "set null",
    }),
    // Their public application, when they submitted one. Plain id with no FK:
    // recruit.ts imports this file (for camp_invite.prospect_id), so a real
    // reference back would be a module cycle — the same reason
    // membership.via_invite_id is a bare id.
    recruitApplicationId: text("recruit_application_id"),
    createdByMembershipId: text("created_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    index("prospect_camp").on(t.campId, t.status),
    index("prospect_owner").on(t.ownerMembershipId),
    // Matching an incoming application to "do we already know this person".
    index("prospect_email").on(t.campId, t.email),
  ],
);

/**
 * A way to reach a prospect. A separate table rather than JSON on `prospect`
 * because the lookup — "has anyone already got a thread with this Facebook
 * profile?" — is the whole point, and it is what stops two officers building
 * parallel records for one human.
 */
export const prospectHandle = sqliteTable(
  "prospect_handle",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id")
      .notNull()
      .references(() => prospect.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("other"),
    // The handle itself — a URL, an @name, an address. Stored as typed.
    value: text("value").notNull(),
    // Optional human label ("her personal account, not the business one").
    label: text("label"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    // Merging two prospects re-points handles with UPDATE OR IGNORE, so this
    // uniqueness is what makes duplicate handles collapse instead of erroring.
    uniqueIndex("prospect_handle_unique").on(t.prospectId, t.kind, t.value),
    index("prospect_handle_lookup").on(t.campId, t.value),
  ],
);

/**
 * One logged conversation. The body holds what was actually said — pasted
 * text, or a screenshot, since bodies use the wiki markup format that already
 * supports pictures.
 */
export const prospectInteraction = sqliteTable(
  "prospect_interaction",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    prospectId: text("prospect_id")
      .notNull()
      .references(() => prospect.id, { onDelete: "cascade" }),
    // The officer who logged it. NULL once they leave the camp — the record
    // outlives them and is still worth reading.
    authorMembershipId: text("author_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    channel: text("channel").notNull().default("other"),
    // inbound (they contacted us) | outbound (we contacted them) | note (an
    // officer's observation with no message behind it).
    direction: text("direction").notNull().default("note"),
    // When the conversation HAPPENED, which is not when it was logged — an
    // officer pasting a week-old thread needs the log to sort correctly.
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    // Email subject, post title, or a short label for anything else.
    subject: text("subject"),
    // What was said. Wiki markup subset — see app/lib/markup.
    body: text("body"),
    // Permalink back to the original: the Facebook post, the Discord message,
    // the tweet. The ask that started this feature.
    sourceUrl: text("source_url"),
    // A durable id for things that have one but no URL — an email Message-ID
    // most of all, so the thread can be found again in a mail client.
    externalRef: text("external_ref"),
    // Who it was to/from on the other side, when that isn't just the prospect
    // (a group thread, an email that went to three officers).
    counterparty: text("counterparty"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("prospect_interaction_thread").on(t.prospectId, t.occurredAt)],
);
