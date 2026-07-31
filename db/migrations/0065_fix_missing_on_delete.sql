PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_membership` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`playa_name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`joined_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`invited_by_membership_id` text,
	`wizard_step` integer DEFAULT 0 NOT NULL,
	`wizard_completed_at` integer,
	`via_invite_id` text,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_membership`("id", "camp_id", "user_id", "role", "playa_name", "status", "joined_at", "created_at", "invited_by_membership_id", "wizard_step", "wizard_completed_at", "via_invite_id") SELECT "id", "camp_id", "user_id", "role", "playa_name", "status", "joined_at", "created_at", "invited_by_membership_id", "wizard_step", "wizard_completed_at", "via_invite_id" FROM `membership`;--> statement-breakpoint
DROP TABLE `membership`;--> statement-breakpoint
ALTER TABLE `__new_membership` RENAME TO `membership`;--> statement-breakpoint
CREATE TABLE `__new_map_object` (
	`id` text PRIMARY KEY NOT NULL,
	`camp_id` text NOT NULL,
	`name` text,
	`kind` text DEFAULT 'structure' NOT NULL,
	`x` real DEFAULT 0 NOT NULL,
	`y` real DEFAULT 0 NOT NULL,
	`width` real DEFAULT 10 NOT NULL,
	`height` real DEFAULT 10 NOT NULL,
	`rotation` real DEFAULT 0 NOT NULL,
	`color` text,
	`notes` text,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`owner_membership_id` text,
	`placed` integer DEFAULT false NOT NULL,
	`edition_id` text,
	`pending_by_membership_id` text,
	`pending_at` integer,
	`pending_prev` text,
	`tall_ft` real DEFAULT 0 NOT NULL,
	`show_door` integer DEFAULT true NOT NULL,
	`mirrored` integer DEFAULT false NOT NULL,
	`config` text,
	`group_id` text,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`edition_id`) REFERENCES `camp_edition`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`pending_by_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_map_object`("id", "camp_id", "name", "kind", "x", "y", "width", "height", "rotation", "color", "notes", "created_by_id", "created_at", "updated_at", "owner_membership_id", "placed", "edition_id", "pending_by_membership_id", "pending_at", "pending_prev", "tall_ft", "show_door", "mirrored", "config", "group_id") SELECT "id", "camp_id", "name", "kind", "x", "y", "width", "height", "rotation", "color", "notes", "created_by_id", "created_at", "updated_at", "owner_membership_id", "placed", "edition_id", "pending_by_membership_id", "pending_at", "pending_prev", "tall_ft", "show_door", "mirrored", "config", "group_id" FROM `map_object`;--> statement-breakpoint
DROP TABLE `map_object`;--> statement-breakpoint
ALTER TABLE `__new_map_object` RENAME TO `map_object`;--> statement-breakpoint
CREATE INDEX `map_object_camp` ON `map_object` (`camp_id`);--> statement-breakpoint
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
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_membership_id`) REFERENCES `membership`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`promote_attendee_id`) REFERENCES `attendee`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_camp_invite`("id", "camp_id", "inviter_membership_id", "token", "role", "max_uses", "use_count", "expires_at", "revoked_at", "created_at", "kind", "note", "last_used_at", "promote_attendee_id") SELECT "id", "camp_id", "inviter_membership_id", "token", "role", "max_uses", "use_count", "expires_at", "revoked_at", "created_at", "kind", "note", "last_used_at", "promote_attendee_id" FROM `camp_invite`;--> statement-breakpoint
DROP TABLE `camp_invite`;--> statement-breakpoint
ALTER TABLE `__new_camp_invite` RENAME TO `camp_invite`;--> statement-breakpoint
CREATE UNIQUE INDEX `camp_invite_token_unique` ON `camp_invite` (`token`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
