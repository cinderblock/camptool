ALTER TABLE `map_object` ADD `pending_by_membership_id` text REFERENCES membership(id);--> statement-breakpoint
ALTER TABLE `map_object` ADD `pending_at` integer;--> statement-breakpoint
ALTER TABLE `map_object` ADD `pending_prev` text;