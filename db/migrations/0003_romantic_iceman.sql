CREATE TABLE `map_object` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`name` text,
	`kind` text DEFAULT 'structure' NOT NULL,
	`x` real DEFAULT 0 NOT NULL,
	`y` real DEFAULT 0 NOT NULL,
	`width` real DEFAULT 10 NOT NULL,
	`height` real DEFAULT 10 NOT NULL,
	`rotation` real DEFAULT 0 NOT NULL,
	`color` text,
	`notes` text,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `map_object_camp` ON `map_object` (`camp_id`);--> statement-breakpoint
CREATE TABLE `placement` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`street` text,
	`address` text,
	`frontage_ft` real DEFAULT 100 NOT NULL,
	`depth_ft` real DEFAULT 100 NOT NULL,
	`inner_radius_ft` real,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_camp` ON `placement` (`camp_id`);