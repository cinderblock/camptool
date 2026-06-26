CREATE TABLE `client_error` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`stack` text,
	`source` text,
	`line` integer,
	`col` integer,
	`url` text,
	`user_agent` text,
	`user_id` text,
	`camp_id` text,
	`breadcrumbs` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `client_error_created` ON `client_error` (`created_at`);--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`body` text DEFAULT '' NOT NULL,
	`details` text,
	`url` text,
	`user_agent` text,
	`metadata` text,
	`user_id` text,
	`camp_id` text,
	`edition_id` text,
	`status` text DEFAULT 'new' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `feedback_created` ON `feedback` (`created_at`);