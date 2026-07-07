ALTER TABLE `camp_question` ADD `scope` text DEFAULT 'per_edition' NOT NULL;--> statement-breakpoint
ALTER TABLE `camp_question` ADD `surface` text DEFAULT 'wizard' NOT NULL;--> statement-breakpoint
ALTER TABLE `recruit_application` ADD `answers` text;--> statement-breakpoint
ALTER TABLE `recruit_application` ADD `answers_imported_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `question_answer_once_unique` ON `question_answer` (`membership_id`,`question_id`) WHERE edition_id IS NULL;--> statement-breakpoint
INSERT INTO `camp_question` (`id`, `camp_id`, `prompt`, `help_text`, `type`, `audience`, `wizard_placement`, `scope`, `surface`, `sort_order`)
SELECT lower(hex(randomblob(16))), `c`.`id`,
	'Which camp did you camp with before?',
	'If you''ve been to Burning Man before — the camp(s) you were part of. Solo or freecamping counts too. Skip if this is your first burn.',
	'short_text', 'recruit', 'before', 'once', 'both',
	(SELECT COALESCE(MAX(`sort_order`), 0) + 1 FROM `camp_question` `q` WHERE `q`.`camp_id` = `c`.`id`)
FROM `camp` `c`;--> statement-breakpoint
INSERT INTO `camp_question` (`id`, `camp_id`, `prompt`, `help_text`, `type`, `audience`, `wizard_placement`, `scope`, `surface`, `sort_order`)
SELECT lower(hex(randomblob(16))), `c`.`id`,
	'How was your previous camp — and why a new one?',
	'What you liked (or didn''t) about your previous camp, and/or what you''re hoping to find here.',
	'long_text', 'recruit', 'before', 'once', 'both',
	(SELECT COALESCE(MAX(`sort_order`), 0) + 1 FROM `camp_question` `q` WHERE `q`.`camp_id` = `c`.`id`)
FROM `camp` `c`;