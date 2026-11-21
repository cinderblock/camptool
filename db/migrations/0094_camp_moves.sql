CREATE TABLE `camp_move_in` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`source_origin` text NOT NULL,
	`source_camp_url` text NOT NULL,
	`source_rp_id` text NOT NULL,
	`public_key` text NOT NULL,
	`imported_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`window_ends_at` integer NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`imported_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `camp_move_out` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text,
	`camp_slug` text,
	`camp_name` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`secret_hash` text NOT NULL,
	`secret_sealed` text NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`target_origin` text,
	`target_camp_url` text,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`code_expires_at` integer NOT NULL,
	`done_at` integer,
	`window_ends_at` integer,
	`data_deleted_at` integer,
	`people` text,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `camp_move_out_camp` ON `camp_move_out` (`camp_id`);--> statement-breakpoint
CREATE TABLE `camp_move_user` (
	`id` text PRIMARY KEY NOT NULL,
	`move_id` text NOT NULL,
	`source_user_id` text NOT NULL,
	`user_id` text NOT NULL,
	`outcome` text NOT NULL,
	`email` text,
	`claimed_at` integer,
	FOREIGN KEY (`move_id`) REFERENCES `camp_move_in`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `camp_move_user_source` ON `camp_move_user` (`move_id`,`source_user_id`);--> statement-breakpoint
CREATE INDEX `camp_move_user_user` ON `camp_move_user` (`user_id`);