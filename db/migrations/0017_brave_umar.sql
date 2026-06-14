CREATE TABLE `camp_question` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`prompt` text NOT NULL,
	`help_text` text,
	`type` text DEFAULT 'short_text' NOT NULL,
	`options` text,
	`audience` text DEFAULT 'all' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `camp_question_camp` ON `camp_question` (`camp_id`);--> statement-breakpoint
CREATE TABLE `question_answer` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`question_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`value` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `camp_question`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `question_answer_member` ON `question_answer` (`edition_id`,`membership_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `question_answer_unique` ON `question_answer` (`edition_id`,`membership_id`,`question_id`);