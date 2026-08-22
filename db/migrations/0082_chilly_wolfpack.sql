ALTER TABLE `attendee` ADD `age_band` text;--> statement-breakpoint
ALTER TABLE `map_object` ADD `needs_egress` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `map_object` ADD `egress_note` text;