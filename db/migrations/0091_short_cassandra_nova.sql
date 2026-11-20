CREATE TABLE `camp_setup_link` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`label` text NOT NULL,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`used_at` integer,
	`used_by_user_id` text,
	`camp_id` text,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`used_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `camp_setup_link_token_unique` ON `camp_setup_link` (`token`);