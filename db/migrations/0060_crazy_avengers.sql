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
SELECT lower(hex(randomblob(16))), `camp`.`id`, `k`.`key`, 'on'
FROM `camp`, (
	SELECT 'announcements' AS `key`
	UNION ALL SELECT 'documents'
	UNION ALL SELECT 'questions'
	UNION ALL SELECT 'onboarding'
	UNION ALL SELECT 'map'
	UNION ALL SELECT 'bringing'
	UNION ALL SELECT 'supplies'
	UNION ALL SELECT 'tickets'
	UNION ALL SELECT 'passes'
	UNION ALL SELECT 'finances'
	UNION ALL SELECT 'recruiting'
	UNION ALL SELECT 'roster'
) AS `k`;
--> statement-breakpoint
INSERT INTO `camp_feature` (`id`, `camp_id`, `feature_key`, `state`)
SELECT lower(hex(randomblob(16))), `id`, 'dues', 'on'
FROM `camp` WHERE `tracks_dues` = 1;