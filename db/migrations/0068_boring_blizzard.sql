CREATE TABLE `fuel_declaration` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`fuel_type` text NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`unit` text DEFAULT 'gal' NOT NULL,
	`container_type` text,
	`container_count` integer DEFAULT 1 NOT NULL,
	`secondary_containment` integer,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fuel_declaration_edition` ON `fuel_declaration` (`edition_id`);--> statement-breakpoint
CREATE INDEX `fuel_declaration_member` ON `fuel_declaration` (`membership_id`);--> statement-breakpoint
ALTER TABLE `map_object` ADD `needs_pumpout` integer DEFAULT false NOT NULL;