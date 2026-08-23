CREATE TABLE `camp_meeting_room` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`url` text NOT NULL,
	`label` text,
	`note` text,
	`updated_by_membership_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `camp_meeting_room_camp` ON `camp_meeting_room` (`camp_id`);--> statement-breakpoint
CREATE TABLE `meeting_agenda_item` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`occurrence_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`added_by_membership_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`occurrence_id`) REFERENCES `gathering_occurrence`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `meeting_agenda_occurrence` ON `meeting_agenda_item` (`occurrence_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `meeting_summary` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`occurrence_id` text NOT NULL,
	`body` text NOT NULL,
	`author_membership_id` text,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`occurrence_id`) REFERENCES `gathering_occurrence`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_summary_occurrence` ON `meeting_summary` (`occurrence_id`);--> statement-breakpoint
CREATE TABLE `meeting_summary_read` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`summary_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`read_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`summary_id`) REFERENCES `meeting_summary`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_summary_read_unique` ON `meeting_summary_read` (`summary_id`,`membership_id`);