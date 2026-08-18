CREATE TABLE `prospect` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`name` text NOT NULL,
	`playa_name` text,
	`email` text,
	`phone` text,
	`notes` text,
	`status` text DEFAULT 'lead' NOT NULL,
	`owner_membership_id` text,
	`next_follow_up_at` integer,
	`membership_id` text,
	`recruit_application_id` text,
	`created_by_membership_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `prospect_camp` ON `prospect` (`camp_id`,`status`);--> statement-breakpoint
CREATE INDEX `prospect_owner` ON `prospect` (`owner_membership_id`);--> statement-breakpoint
CREATE INDEX `prospect_email` ON `prospect` (`camp_id`,`email`);--> statement-breakpoint
CREATE TABLE `prospect_handle` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`prospect_id` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`value` text NOT NULL,
	`label` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospect`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prospect_handle_unique` ON `prospect_handle` (`prospect_id`,`kind`,`value`);--> statement-breakpoint
CREATE INDEX `prospect_handle_lookup` ON `prospect_handle` (`camp_id`,`value`);--> statement-breakpoint
CREATE TABLE `prospect_interaction` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`prospect_id` text NOT NULL,
	`author_membership_id` text,
	`channel` text DEFAULT 'other' NOT NULL,
	`direction` text DEFAULT 'note' NOT NULL,
	`occurred_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`subject` text,
	`body` text,
	`source_url` text,
	`external_ref` text,
	`counterparty` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospect`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `prospect_interaction_thread` ON `prospect_interaction` (`prospect_id`,`occurred_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_camp_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`inviter_membership_id` text NOT NULL,
	`token` text NOT NULL,
	`role` text DEFAULT 'recruit' NOT NULL,
	`max_uses` integer,
	`use_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`kind` text DEFAULT 'personal' NOT NULL,
	`note` text,
	`last_used_at` integer,
	`promote_attendee_id` text,
	`prospect_id` text,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`promote_attendee_id`) REFERENCES `attendee`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospect`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_camp_invite`("id", "camp_id", "inviter_membership_id", "token", "role", "max_uses", "use_count", "expires_at", "revoked_at", "created_at", "kind", "note", "last_used_at", "promote_attendee_id") SELECT "id", "camp_id", "inviter_membership_id", "token", "role", "max_uses", "use_count", "expires_at", "revoked_at", "created_at", "kind", "note", "last_used_at", "promote_attendee_id" FROM `camp_invite`;--> statement-breakpoint
DROP TABLE `camp_invite`;--> statement-breakpoint
ALTER TABLE `__new_camp_invite` RENAME TO `camp_invite`;--> statement-breakpoint
CREATE UNIQUE INDEX `camp_invite_token_unique` ON `camp_invite` (`token`);--> statement-breakpoint
PRAGMA foreign_keys=ON;