CREATE TABLE `camp_bins` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`base_url` text NOT NULL,
	`access_code` text,
	`label` text,
	`updated_by_membership_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `camp_bins_camp` ON `camp_bins` (`camp_id`);