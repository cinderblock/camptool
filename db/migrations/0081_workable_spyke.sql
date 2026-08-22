ALTER TABLE `attendee` ADD `wants_communal_shade` integer;--> statement-breakpoint
ALTER TABLE `membership` ADD `pronouns` text;--> statement-breakpoint
ALTER TABLE `membership` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `membership` ADD `emergency_contact_name` text;--> statement-breakpoint
ALTER TABLE `membership` ADD `emergency_contact_phone` text;--> statement-breakpoint
ALTER TABLE `camp_question` ADD `show_if_question_id` text;--> statement-breakpoint
ALTER TABLE `camp_question` ADD `show_if_value` text;