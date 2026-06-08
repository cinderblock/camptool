CREATE TABLE `camp_edition` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`year` integer NOT NULL,
	`label` text,
	`locked` integer DEFAULT false NOT NULL,
	`forked_from_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`forked_from_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `camp_edition_camp_year` ON `camp_edition` (`camp_id`,`year`);--> statement-breakpoint
DROP INDEX `placement_camp`;--> statement-breakpoint
ALTER TABLE `placement` ADD `edition_id` text REFERENCES camp_edition(id);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_edition` ON `placement` (`edition_id`);--> statement-breakpoint
ALTER TABLE `map_object` ADD `edition_id` text REFERENCES camp_edition(id);--> statement-breakpoint
ALTER TABLE `map_object_occupant` ADD `edition_id` text REFERENCES camp_edition(id);--> statement-breakpoint
-- Backfill: one edition per existing camp (year from its placement, else 2025),
-- then point existing map/inventory rows at it. Deterministic id so the three
-- UPDATEs can target it without a roundtrip.
INSERT INTO `camp_edition` (`id`, `camp_id`, `year`, `label`, `locked`, `created_at`)
SELECT 'ed_' || `id`, `id`,
  COALESCE((SELECT `placement_year` FROM `placement` WHERE `placement`.`camp_id` = `camp`.`id` LIMIT 1), CAST(strftime('%Y','now') AS INTEGER)),
  NULL, 0, (unixepoch() * 1000)
FROM `camp`;--> statement-breakpoint
UPDATE `placement` SET `edition_id` = 'ed_' || `camp_id`;--> statement-breakpoint
UPDATE `map_object` SET `edition_id` = 'ed_' || `camp_id`;--> statement-breakpoint
UPDATE `map_object_occupant` SET `edition_id` = 'ed_' || `camp_id`;