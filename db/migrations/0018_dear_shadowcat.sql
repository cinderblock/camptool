ALTER TABLE `camp_edition` ADD `ticket_sale_starts_at` integer;--> statement-breakpoint
ALTER TABLE `camp_edition` ADD `ticket_sale_ends_at` integer;--> statement-breakpoint
ALTER TABLE `ticket` ADD `purchase_url` text;--> statement-breakpoint
-- Backfill: the camp no longer tracks payment; legacy 'paid' tickets are the
-- member-confirmed 'purchased' state under the new available->assigned->purchased lifecycle.
UPDATE `ticket` SET `status` = 'purchased' WHERE `status` = 'paid';