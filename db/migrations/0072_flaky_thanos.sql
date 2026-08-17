CREATE TABLE `faq_category` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `faq_category_camp` ON `faq_category` (`camp_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `faq_category_slug_unique` ON `faq_category` (`camp_id`,`slug`);--> statement-breakpoint
CREATE TABLE `faq_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`slug` text NOT NULL,
	`question` text NOT NULL,
	`answer` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'published' NOT NULL,
	`category_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`asked_by_id` text,
	`asked_at` integer,
	`answered_by_id` text,
	`answered_at` integer,
	`created_by_id` text,
	`updated_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `faq_category`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`asked_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`answered_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `faq_entry_camp_status` ON `faq_entry` (`camp_id`,`status`,`position`);--> statement-breakpoint
CREATE INDEX `faq_entry_asked_by` ON `faq_entry` (`camp_id`,`asked_by_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `faq_entry_slug_unique` ON `faq_entry` (`camp_id`,`slug`);