CREATE TABLE `camp_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`inviter_membership_id` text NOT NULL,
	`token` text NOT NULL,
	`role` text DEFAULT 'recruit' NOT NULL,
	`max_uses` integer,
	`use_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `camp_invite_token_unique` ON `camp_invite` (`token`);--> statement-breakpoint
ALTER TABLE `membership` ADD `invited_by_membership_id` text REFERENCES membership(id);