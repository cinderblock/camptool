CREATE TABLE `swap_listing` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`kind` text NOT NULL,
	`direction` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`price_cents` integer,
	`note` text,
	`status` text DEFAULT 'open' NOT NULL,
	`claimed_by_membership_id` text,
	`claimed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`claimed_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `swap_listing_edition` ON `swap_listing` (`edition_id`,`status`);--> statement-breakpoint
CREATE INDEX `swap_listing_member` ON `swap_listing` (`membership_id`);