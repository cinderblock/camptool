ALTER TABLE `membership` ADD `wizard_step` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `membership` ADD `wizard_completed_at` integer;