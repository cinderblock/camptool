ALTER TABLE `map_object_occupant` ADD `attendee_id` text REFERENCES attendee(id);--> statement-breakpoint
CREATE INDEX `map_object_occupant_attendee` ON `map_object_occupant` (`attendee_id`);--> statement-breakpoint
-- Backfill: ensure every occupant's member has an attendee row for that edition
-- (created status 'unknown', name/email NULL → resolved from the user), then
-- point each occupant at it. Unifies occupants onto the attendee entity so a
-- non-member guest can be an occupant. membership_id is dropped in 0053.
INSERT INTO `attendee` (`id`, `camp_id`, `edition_id`, `membership_id`, `status`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), o.`camp_id`, o.`edition_id`, o.`membership_id`, 'unknown', (unixepoch() * 1000), (unixepoch() * 1000)
FROM `map_object_occupant` o
WHERE o.`edition_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `attendee` a
    WHERE a.`edition_id` = o.`edition_id` AND a.`membership_id` = o.`membership_id`
  )
GROUP BY o.`edition_id`, o.`membership_id`;--> statement-breakpoint
UPDATE `map_object_occupant`
SET `attendee_id` = (
  SELECT a.`id` FROM `attendee` a
  WHERE a.`edition_id` = `map_object_occupant`.`edition_id`
    AND a.`membership_id` = `map_object_occupant`.`membership_id`
)
WHERE `attendee_id` IS NULL;