CREATE TABLE `camp_group` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text,
	`created_by_membership_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `camp_group_name` ON `camp_group` (`camp_id`,lower("name"));--> statement-breakpoint
CREATE TABLE `camp_group_member` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`group_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`added_by_membership_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `camp_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `camp_group_member_unique` ON `camp_group_member` (`group_id`,`membership_id`);