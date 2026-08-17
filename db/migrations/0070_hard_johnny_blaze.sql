CREATE TABLE `wiki_link` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`page_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`page_id`) REFERENCES `wiki_page`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_link_unique` ON `wiki_link` (`page_id`,`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `wiki_link_subject` ON `wiki_link` (`camp_id`,`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `wiki_page` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`created_by_id` text,
	`updated_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `wiki_page_camp` ON `wiki_page` (`camp_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_page_slug_unique` ON `wiki_page` (`camp_id`,`slug`);--> statement-breakpoint
CREATE TABLE `wiki_revision` (
	`id` text PRIMARY KEY NOT NULL,
	`page_id` text NOT NULL,
	`camp_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`summary` text,
	`edited_by_id` text,
	`edited_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `wiki_page`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edited_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `wiki_revision_page` ON `wiki_revision` (`page_id`,`edited_at`);--> statement-breakpoint
CREATE INDEX `wiki_revision_camp` ON `wiki_revision` (`camp_id`);