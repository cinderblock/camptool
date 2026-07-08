ALTER TABLE `setup_pass` ADD `attendee_id` text REFERENCES attendee(id);--> statement-breakpoint
-- Backfill: give each pass's member an attendee row for that edition if they
-- lack one (status 'unknown'), then point the pass at it. Unifies passes onto
-- the attendee entity. membership_id → dropped in 0059.
INSERT INTO `attendee` (`id`, `camp_id`, `edition_id`, `membership_id`, `status`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), p.`camp_id`, p.`edition_id`, p.`membership_id`, 'unknown', (unixepoch() * 1000), (unixepoch() * 1000)
FROM `setup_pass` p
WHERE p.`edition_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `attendee` a
    WHERE a.`edition_id` = p.`edition_id` AND a.`membership_id` = p.`membership_id`
  )
GROUP BY p.`edition_id`, p.`membership_id`;--> statement-breakpoint
UPDATE `setup_pass`
SET `attendee_id` = (
  SELECT a.`id` FROM `attendee` a
  WHERE a.`edition_id` = `setup_pass`.`edition_id`
    AND a.`membership_id` = `setup_pass`.`membership_id`
)
WHERE `attendee_id` IS NULL;