CREATE TABLE `setup_pass` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`pass_date_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`note` text,
	`resolved_by_membership_id` text,
	`resolved_at` integer,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pass_date_id`) REFERENCES `setup_pass_date`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `setup_pass_edition` ON `setup_pass` (`edition_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `setup_pass_member_date` ON `setup_pass` (`pass_date_id`,`membership_id`);--> statement-breakpoint
CREATE TABLE `setup_pass_date` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`date` text NOT NULL,
	`label` text,
	`quota` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `setup_pass_date_unique` ON `setup_pass_date` (`edition_id`,`date`);--> statement-breakpoint
CREATE TABLE `ticket` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`tier` text,
	`price_cents` integer,
	`assigned_membership_id` text,
	`status` text DEFAULT 'available' NOT NULL,
	`notes` text,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ticket_edition` ON `ticket` (`edition_id`);--> statement-breakpoint
CREATE TABLE `ticket_request` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`membership_id` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_ticket_id` text,
	`resolved_by_membership_id` text,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_ticket_id`) REFERENCES `ticket`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ticket_request_edition` ON `ticket_request` (`edition_id`);