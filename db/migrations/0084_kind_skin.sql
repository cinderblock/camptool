-- `ON DELETE SET NULL` is hand-added: drizzle-kit drops the referential action
-- from a SQLite `ADD COLUMN`, and a bare `REFERENCES` defaults to NO ACTION,
-- which with `PRAGMA foreign_keys = ON` (db/client.server.ts) would block
-- deleting any membership that had sent an invitation. Same fix, same reason as
-- 0065_fix_missing_on_delete and 0075. The schema declares `set null`, so the
-- snapshot already agrees and no future generate will try to "correct" this.
ALTER TABLE `attendee` ADD `pending_host_membership_id` text REFERENCES membership(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `attendee_pending_host` ON `attendee` (`pending_host_membership_id`);
