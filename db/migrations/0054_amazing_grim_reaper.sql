ALTER TABLE `ticket` ADD `assigned_attendee_id` text REFERENCES attendee(id);--> statement-breakpoint
-- Backfill: give each assigned member an attendee row for the ticket's edition
-- if they lack one (status 'unknown'), then point the ticket at it. Unifies
-- ticket assignment onto the attendee entity. assigned_membership_id → 0055.
INSERT INTO `attendee` (`id`, `camp_id`, `edition_id`, `membership_id`, `status`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), t.`camp_id`, t.`edition_id`, t.`assigned_membership_id`, 'unknown', (unixepoch() * 1000), (unixepoch() * 1000)
FROM `ticket` t
WHERE t.`assigned_membership_id` IS NOT NULL
  AND t.`edition_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `attendee` a
    WHERE a.`edition_id` = t.`edition_id` AND a.`membership_id` = t.`assigned_membership_id`
  )
GROUP BY t.`edition_id`, t.`assigned_membership_id`;--> statement-breakpoint
UPDATE `ticket`
SET `assigned_attendee_id` = (
  SELECT a.`id` FROM `attendee` a
  WHERE a.`edition_id` = `ticket`.`edition_id`
    AND a.`membership_id` = `ticket`.`assigned_membership_id`
)
WHERE `assigned_membership_id` IS NOT NULL;