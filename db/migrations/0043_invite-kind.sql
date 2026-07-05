ALTER TABLE `camp_invite` ADD `kind` text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
UPDATE `camp_invite` SET `kind` = 'open' WHERE `max_uses` IS NULL;
