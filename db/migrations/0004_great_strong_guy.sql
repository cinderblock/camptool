CREATE TABLE `map_object_occupant` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`object_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`object_id`) REFERENCES `map_object`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `map_object_occupant_unique` ON `map_object_occupant` (`object_id`,`membership_id`);--> statement-breakpoint
CREATE INDEX `map_object_occupant_object` ON `map_object_occupant` (`object_id`);--> statement-breakpoint
ALTER TABLE `map_object` ADD `owner_membership_id` text REFERENCES membership(id);--> statement-breakpoint
ALTER TABLE `map_object` ADD `placed` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing objects predate the unplaced-queue model; they were all placed.
UPDATE `map_object` SET `placed` = true;