PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_map_object_occupant` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`object_id` text NOT NULL,
	`attendee_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`object_id`) REFERENCES `map_object`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendee`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_map_object_occupant`("id", "camp_id", "edition_id", "object_id", "attendee_id", "created_at") SELECT "id", "camp_id", "edition_id", "object_id", "attendee_id", "created_at" FROM `map_object_occupant`;--> statement-breakpoint
DROP TABLE `map_object_occupant`;--> statement-breakpoint
ALTER TABLE `__new_map_object_occupant` RENAME TO `map_object_occupant`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `map_object_occupant_unique` ON `map_object_occupant` (`object_id`,`attendee_id`);--> statement-breakpoint
CREATE INDEX `map_object_occupant_object` ON `map_object_occupant` (`object_id`);--> statement-breakpoint
CREATE INDEX `map_object_occupant_attendee` ON `map_object_occupant` (`attendee_id`);