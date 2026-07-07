PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ticket` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`tier` text,
	`price_cents` integer,
	`assigned_attendee_id` text,
	`status` text DEFAULT 'available' NOT NULL,
	`notes` text,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_attendee_id`) REFERENCES `attendee`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_ticket`("id", "camp_id", "edition_id", "tier", "price_cents", "assigned_attendee_id", "status", "notes", "created_by_id", "created_at", "updated_at") SELECT "id", "camp_id", "edition_id", "tier", "price_cents", "assigned_attendee_id", "status", "notes", "created_by_id", "created_at", "updated_at" FROM `ticket`;--> statement-breakpoint
DROP TABLE `ticket`;--> statement-breakpoint
ALTER TABLE `__new_ticket` RENAME TO `ticket`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ticket_edition` ON `ticket` (`edition_id`);