CREATE TABLE `attendee` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`membership_id` text,
	`host_membership_id` text,
	`name` text,
	`email` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`arrival_date` text,
	`departure_date` text,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attendee_edition` ON `attendee` (`edition_id`);--> statement-breakpoint
CREATE INDEX `attendee_host` ON `attendee` (`host_membership_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attendee_member` ON `attendee` (`edition_id`,`membership_id`) WHERE "attendee"."membership_id" is not null;--> statement-breakpoint
-- Backfill: fold each member's `participation` row into their own `attendee`
-- row (membership_id set; name/email NULL → resolved from the user). Random hex
-- ids. `participation` is dropped in migration 0050 after this copy.
INSERT INTO `attendee` (`id`, `camp_id`, `edition_id`, `membership_id`, `host_membership_id`, `name`, `email`, `status`, `arrival_date`, `departure_date`, `note`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), `camp_id`, `edition_id`, `membership_id`, NULL, NULL, NULL, `status`, `arrival_date`, `departure_date`, `note`, `created_at`, `updated_at`
FROM `participation`;