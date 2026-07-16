CREATE TABLE `gathering` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`title` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'work_party' NOT NULL,
	`location` text,
	`recurrence_rule` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `gathering_edition` ON `gathering` (`edition_id`);--> statement-breakpoint
CREATE TABLE `gathering_occurrence` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`gathering_id` text NOT NULL,
	`date` text NOT NULL,
	`start_time` text,
	`end_time` text,
	`title_override` text,
	`location_override` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`gathering_id`) REFERENCES `gathering`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gathering_occurrence_edition` ON `gathering_occurrence` (`edition_id`,`date`);--> statement-breakpoint
CREATE INDEX `gathering_occurrence_gathering` ON `gathering_occurrence` (`gathering_id`,`date`);--> statement-breakpoint
CREATE TABLE `gathering_shift` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`occurrence_id` text NOT NULL,
	`role` text,
	`staffing` text DEFAULT 'open' NOT NULL,
	`min_needed` integer,
	`capacity` integer,
	`start_time` text,
	`end_time` text,
	`note` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`occurrence_id`) REFERENCES `gathering_occurrence`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gathering_shift_occurrence` ON `gathering_shift` (`occurrence_id`);--> statement-breakpoint
CREATE TABLE `gathering_signup` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`shift_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`status` text DEFAULT 'signed_up' NOT NULL,
	`attendance` text DEFAULT 'unknown' NOT NULL,
	`origin` text DEFAULT 'self' NOT NULL,
	`note` text,
	`recorded_by_membership_id` text,
	`recorded_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shift_id`) REFERENCES `gathering_shift`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recorded_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gathering_signup_unique` ON `gathering_signup` (`shift_id`,`membership_id`);--> statement-breakpoint
CREATE INDEX `gathering_signup_member` ON `gathering_signup` (`edition_id`,`membership_id`);--> statement-breakpoint
CREATE TABLE `gathering_requirement` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`gathering_id` text NOT NULL,
	`training_id` text NOT NULL,
	`enforcement` text DEFAULT 'required' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`gathering_id`) REFERENCES `gathering`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`training_id`) REFERENCES `training`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gathering_requirement_unique` ON `gathering_requirement` (`gathering_id`,`training_id`);--> statement-breakpoint
CREATE TABLE `training` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`validity` text DEFAULT 'per_edition' NOT NULL,
	`archived_at` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `training_camp` ON `training` (`camp_id`);--> statement-breakpoint
CREATE TABLE `training_signoff` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`training_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`edition_id` text,
	`granted_by_membership_id` text,
	`granted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer,
	`note` text,
	`revoked_at` integer,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`training_id`) REFERENCES `training`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `training_signoff_member` ON `training_signoff` (`training_id`,`membership_id`);