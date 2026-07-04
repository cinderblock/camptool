CREATE TABLE `map_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text NOT NULL,
	`kind` text DEFAULT 'auto' NOT NULL,
	`label` text,
	`seq` integer DEFAULT 0 NOT NULL,
	`data` text NOT NULL,
	`created_by_membership_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `map_snapshot_edition` ON `map_snapshot` (`edition_id`,`kind`,`seq`);--> statement-breakpoint
ALTER TABLE `camp_edition` ADD `map_undo_cursor` integer;