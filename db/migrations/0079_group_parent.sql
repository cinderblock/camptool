ALTER TABLE `camp_group` ADD `parent_group_id` text REFERENCES camp_group(id) ON DELETE SET NULL;
