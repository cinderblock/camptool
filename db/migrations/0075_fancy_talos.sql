ALTER TABLE `map_object` ADD `staged` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `map_object` ADD `near_membership_id` text REFERENCES membership(id) ON DELETE SET NULL;