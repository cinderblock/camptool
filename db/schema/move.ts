/**
 * Camps moving between CampTool installs (plans/camp-portability.md).
 *
 * - `camp_move_out`: on the install a camp is leaving. Outlives the camp's
 *   data: once the camp is deleted here, this row is what forwards its old
 *   links and vouches for its people's sign-ins until the window ends.
 * - `camp_move_in` + `camp_move_user`: on the install a camp arrived at. Which
 *   source it came from, the key that source signs sign-in hand-offs with, and
 *   who each of its people became here.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { camp } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const campMoveOut = sqliteTable(
  "camp_move_out",
  {
    /** Also the move id in the move code. */
    id: text("id").primaryKey(),
    /** Cleared when the camp's data is deleted; the move row stays. */
    campId: text("camp_id").references(() => camp.id, {
      onDelete: "set null",
    }),
    /** Kept so forwarding still knows the camp's old address afterwards. */
    campSlug: text("camp_slug"),
    campName: text("camp_name").notNull(),
    /**
     * `open`: code issued, camp frozen, waiting for a target.
     * `done`: the target imported it; forwarding and the login bridge run.
     * `cancelled`: the camp admin called it off; the camp is unfrozen.
     * `ended`: the window is over.
     */
    state: text("state").notNull().default("open"),
    /** SHA-256 of the move code's secret: the pull API's bearer token. */
    secretHash: text("secret_hash").notNull(),
    /** The secret itself, encrypted with BETTER_AUTH_SECRET, so the camp
     * admin can see the code again and download the bundle file. */
    secretSealed: text("secret_sealed").notNull(),
    /** Ed25519, raw, base64url. */
    publicKey: text("public_key").notNull(),
    /** Ed25519 PKCS#8, encrypted with BETTER_AUTH_SECRET (AES-GCM). */
    privateKey: text("private_key").notNull(),
    /** The install that took the camp, once it says so. */
    targetOrigin: text("target_origin"),
    targetCampUrl: text("target_camp_url"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    /** An unused code stops working after this. */
    codeExpiresAt: integer("code_expires_at", {
      mode: "timestamp_ms",
    }).notNull(),
    doneAt: integer("done_at", { mode: "timestamp_ms" }),
    /** Forwarding and the login bridge stop after this. */
    windowEndsAt: integer("window_ends_at", { mode: "timestamp_ms" }),
    dataDeletedAt: integer("data_deleted_at", { mode: "timestamp_ms" }),
    /** JSON array of the camp's people (user ids), taken when the move is
     * done: whose sign-ins the bridge vouches for, and whose accounts are
     * removed at the end if they're left in no camp. */
    people: text("people"),
  },
  (t) => [index("camp_move_out_camp").on(t.campId)],
);

export const campMoveIn = sqliteTable("camp_move_in", {
  /** The source's move id. */
  id: text("id").primaryKey(),
  campId: text("camp_id")
    .notNull()
    .references(() => camp.id, { onDelete: "cascade" }),
  sourceOrigin: text("source_origin").notNull(),
  sourceCampUrl: text("source_camp_url").notNull(),
  /** The RP ID the camp's old passkeys belong to. */
  sourceRpId: text("source_rp_id").notNull(),
  /** The source's Ed25519 key for sign-in hand-offs. */
  publicKey: text("public_key").notNull(),
  importedByUserId: text("imported_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
  /** Hand-offs and old passkeys are accepted until then. */
  windowEndsAt: integer("window_ends_at", { mode: "timestamp_ms" }).notNull(),
  /** When the source acknowledged the import (it then deletes and forwards). */
  confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
});

export const campMoveUser = sqliteTable(
  "camp_move_user",
  {
    id: text("id").primaryKey(),
    moveId: text("move_id")
      .notNull()
      .references(() => campMoveIn.id, { onDelete: "cascade" }),
    sourceUserId: text("source_user_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * `created`: a new account here, carrying their passkeys (as legacy) and
     * Discord link. `linked`: an account that already existed here and is
     * provably the same person; nothing was added to it. `claim`: an account
     * with their address exists here but isn't provably them; `user_id` is a
     * placeholder until they claim it.
     */
    outcome: text("outcome").notNull(),
    /** For a claim: the address the placeholder stands in for. */
    email: text("email"),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("camp_move_user_source").on(t.moveId, t.sourceUserId),
    index("camp_move_user_user").on(t.userId),
  ],
);
