-- D1 version of db/migrations/0060_crazy_avengers.sql (see README.md here).
-- D1 caps a compound SELECT at a handful of terms, and the original's
-- feature-key list is a 12-way UNION ALL. A multi-row VALUES list is exempt
-- from that limit and means the same thing.
CREATE TABLE `camp_feature` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`feature_key` text NOT NULL,
	`state` text DEFAULT 'off' NOT NULL,
	`updated_by_membership_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `camp_feature_unique` ON `camp_feature` (`camp_id`,`feature_key`);
--> statement-breakpoint
INSERT INTO `camp_feature` (`id`, `camp_id`, `feature_key`, `state`)
SELECT lower(hex(randomblob(16))), `camp`.`id`, `k`.`column1`, 'on'
FROM `camp`, (
	VALUES ('announcements'), ('documents'), ('questions'), ('onboarding'),
		('map'), ('bringing'), ('supplies'), ('tickets'), ('passes'),
		('finances'), ('recruiting'), ('roster')
) AS `k`;
--> statement-breakpoint
INSERT INTO `camp_feature` (`id`, `camp_id`, `feature_key`, `state`)
SELECT lower(hex(randomblob(16))), `id`, 'dues', 'on'
FROM `camp` WHERE `tracks_dues` = 1;
