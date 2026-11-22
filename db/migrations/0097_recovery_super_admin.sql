PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_password_reset` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text,
	`user_id` text NOT NULL,
	`issued_by_membership_id` text,
	`issued_by_user_id` text,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issued_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`issued_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_password_reset`("id", "camp_id", "user_id", "issued_by_membership_id", "token_hash", "expires_at", "used_at", "revoked_at", "attempts", "created_at") SELECT "id", "camp_id", "user_id", "issued_by_membership_id", "token_hash", "expires_at", "used_at", "revoked_at", "attempts", "created_at" FROM `password_reset`;--> statement-breakpoint
DROP TABLE `password_reset`;--> statement-breakpoint
ALTER TABLE `__new_password_reset` RENAME TO `password_reset`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `password_reset_token_hash_unique` ON `password_reset` (`token_hash`);