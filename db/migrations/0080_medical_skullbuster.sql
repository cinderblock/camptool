CREATE TABLE `sap_document` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`filename` text NOT NULL,
	`byte_size` integer NOT NULL,
	`page_count` integer DEFAULT 0 NOT NULL,
	`imported_count` integer DEFAULT 0 NOT NULL,
	`confirmation_id` text,
	`uploaded_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sap_document_edition` ON `sap_document` (`edition_id`);--> statement-breakpoint
CREATE TABLE `setup_pass_stock` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`edition_id` text,
	`pass_date_id` text,
	`on_or_after_date` text NOT NULL,
	`vendor_ticket_id` text NOT NULL,
	`confirmation_id` text,
	`security_code` text NOT NULL,
	`scan_code` text NOT NULL,
	`source_document_id` text,
	`source_page_index` integer,
	`status` text DEFAULT 'available' NOT NULL,
	`assigned_attendee_id` text,
	`setup_pass_id` text,
	`assigned_at` integer,
	`assigned_by_membership_id` text,
	`released_at` integer,
	`released_by_membership_id` text,
	`voided_at` integer,
	`voided_by_membership_id` text,
	`void_reason` text,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pass_date_id`) REFERENCES `setup_pass_date`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_document_id`) REFERENCES `sap_document`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assigned_attendee_id`) REFERENCES `attendee`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assigned_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`released_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`voided_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `setup_pass_stock_edition` ON `setup_pass_stock` (`edition_id`,`status`);--> statement-breakpoint
CREATE INDEX `setup_pass_stock_attendee` ON `setup_pass_stock` (`assigned_attendee_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `setup_pass_stock_vendor_ticket` ON `setup_pass_stock` (`edition_id`,`vendor_ticket_id`);--> statement-breakpoint
CREATE TABLE `setup_pass_stock_event` (
	`id` text PRIMARY KEY NOT NULL,
	`stock_id` text NOT NULL,
	`action` text NOT NULL,
	`attendee_id` text,
	`attendee_name` text,
	`actor_membership_id` text,
	`actor_name` text,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `setup_pass_stock`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `setup_pass_stock_event_stock` ON `setup_pass_stock_event` (`stock_id`,`created_at`);