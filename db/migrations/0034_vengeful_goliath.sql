CREATE TABLE `map_road` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`name` text,
	`kind` text DEFAULT 'fire-lane' NOT NULL,
	`color` text DEFAULT '#868e96' NOT NULL,
	`width` real DEFAULT 20 NOT NULL,
	`cutback` real DEFAULT 20 NOT NULL,
	`points` text DEFAULT '[]' NOT NULL,
	`notes` text,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `map_road_edition` ON `map_road` (`edition_id`);