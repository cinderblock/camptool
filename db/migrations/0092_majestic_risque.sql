CREATE TABLE `structure_kind` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`value` text NOT NULL,
	`label` text NOT NULL,
	`group_name` text DEFAULT 'Camp' NOT NULL,
	`color` text DEFAULT '#868e96' NOT NULL,
	`shape` text DEFAULT 'rect' NOT NULL,
	`width` real DEFAULT 10 NOT NULL,
	`height` real DEFAULT 10 NOT NULL,
	`outline` text,
	`tall_ft` real DEFAULT 8 NOT NULL,
	`canopy_shade` integer DEFAULT false NOT NULL,
	`tags` text DEFAULT '["structure"]' NOT NULL,
	`personal` integer DEFAULT false NOT NULL,
	`rigid` integer DEFAULT false NOT NULL,
	`fixed_rotation` integer DEFAULT false NOT NULL,
	`description` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `structure_kind_camp` ON `structure_kind` (`camp_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `structure_kind_value_unique` ON `structure_kind` (`value`);