CREATE TABLE `member_requirement` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`tier_id` text,
	`waived` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tier_id`) REFERENCES `contribution_tier`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_requirement_unique` ON `member_requirement` (`edition_id`,`membership_id`);