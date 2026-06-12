CREATE TABLE `instance_setting` (
	`id` text PRIMARY KEY NOT NULL,
	`allow_camp_creation` integer DEFAULT true NOT NULL,
	`allow_open_signups` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `super_admin` (
	`user_id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `instance_setting` (`id`) VALUES ('singleton');
--> statement-breakpoint
-- Promote the earliest existing account to super admin so an already-seeded
-- deployment isn't left without a deployment owner. Fresh installs have no users
-- here; the first sign-up is promoted at runtime instead (see instance.server.ts).
INSERT INTO `super_admin` (`user_id`)
SELECT `id` FROM `user` ORDER BY `created_at` ASC, `id` ASC LIMIT 1;
