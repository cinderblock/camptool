CREATE TABLE `offering` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`title` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'lecture' NOT NULL,
	`duration_min` integer,
	`status` text DEFAULT 'proposed' NOT NULL,
	`audience` text DEFAULT 'public' NOT NULL,
	`capacity` integer,
	`location` text,
	`proposed_by_membership_id` text,
	`reviewed_by_membership_id` text,
	`reviewed_at` integer,
	`review_note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposed_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewed_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `offering_edition` ON `offering` (`edition_id`,`status`);--> statement-breakpoint
CREATE TABLE `offering_presenter` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`offering_id` text NOT NULL,
	`attendee_id` text,
	`name` text,
	`role` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`offering_id`) REFERENCES `offering`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendee`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `offering_presenter_offering` ON `offering_presenter` (`offering_id`);--> statement-breakpoint
CREATE TABLE `offering_session` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`offering_id` text NOT NULL,
	`date` text NOT NULL,
	`start_time` text,
	`end_time` text,
	`location` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`offering_id`) REFERENCES `offering`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `offering_session_edition` ON `offering_session` (`edition_id`,`date`);--> statement-breakpoint
CREATE INDEX `offering_session_offering` ON `offering_session` (`offering_id`);