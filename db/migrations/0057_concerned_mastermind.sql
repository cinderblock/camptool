CREATE TABLE `member_flag` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`subject_membership_id` text NOT NULL,
	`reporter_membership_id` text,
	`body` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_by_membership_id` text,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reporter_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `member_flag_camp` ON `member_flag` (`camp_id`);