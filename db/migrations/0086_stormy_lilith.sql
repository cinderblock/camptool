CREATE TABLE `map_aerial` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text NOT NULL,
	`image_id` text NOT NULL,
	`label` text,
	`px_width` integer NOT NULL,
	`px_height` integer NOT NULL,
	`cx` real DEFAULT 0 NOT NULL,
	`cy` real DEFAULT 0 NOT NULL,
	`ft_per_px` real DEFAULT 0.1 NOT NULL,
	`rotation` real DEFAULT 0 NOT NULL,
	`opacity` real DEFAULT 0.85 NOT NULL,
	`crop_x0` real DEFAULT 0 NOT NULL,
	`crop_y0` real DEFAULT 0 NOT NULL,
	`crop_x1` real DEFAULT 1 NOT NULL,
	`crop_y1` real DEFAULT 1 NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`image_id`) REFERENCES `camp_image`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `map_aerial_edition` ON `map_aerial` (`edition_id`);