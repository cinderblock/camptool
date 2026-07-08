PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_setup_pass` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`pass_date_id` text,
	`attendee_id` text,
	`status` text DEFAULT 'requested' NOT NULL,
	`note` text,
	`resolved_by_membership_id` text,
	`resolved_at` integer,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pass_date_id`) REFERENCES `setup_pass_date`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendee`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_setup_pass`("id", "camp_id", "edition_id", "pass_date_id", "attendee_id", "status", "note", "resolved_by_membership_id", "resolved_at", "created_by_id", "created_at") SELECT "id", "camp_id", "edition_id", "pass_date_id", "attendee_id", "status", "note", "resolved_by_membership_id", "resolved_at", "created_by_id", "created_at" FROM `setup_pass`;--> statement-breakpoint
DROP TABLE `setup_pass`;--> statement-breakpoint
ALTER TABLE `__new_setup_pass` RENAME TO `setup_pass`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `setup_pass_edition` ON `setup_pass` (`edition_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `setup_pass_attendee_date` ON `setup_pass` (`pass_date_id`,`attendee_id`);