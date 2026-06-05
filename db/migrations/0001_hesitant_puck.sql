CREATE TABLE `onboarding_completion` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`task_id` text NOT NULL,
	`completed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `onboarding_task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_completion_member_task` ON `onboarding_completion` (`membership_id`,`task_id`);--> statement-breakpoint
CREATE TABLE `onboarding_task` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recruit_application` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`playa_name` text,
	`message` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_id` text,
	`reviewed_by_id` text,
	`review_notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`reviewed_at` integer,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewed_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
