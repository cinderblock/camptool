CREATE TABLE `nav_timing` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`total_ms` integer NOT NULL,
	`fetch_ms` integer,
	`ttfb_ms` integer,
	`fetch_lead_ms` integer,
	`server_ms` integer,
	`db_ms` integer,
	`db_waits` integer,
	`colo` text,
	`code_ms` integer,
	`render_ms` integer,
	`net_type` text,
	`net_rtt_ms` integer,
	`user_agent` text,
	`user_id` text,
	`camp_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`camp_id`) REFERENCES `camp`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `nav_timing_created` ON `nav_timing` (`created_at`);