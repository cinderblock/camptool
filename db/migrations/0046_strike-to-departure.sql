-- Custom data migration: the "Which day can you stay until (strike)?" camp
-- question predates participation.departure_date (the booking-style stay
-- picker, migration 0042) and duplicates it. Preserve everyone's existing
-- answers by copying them into participation, then delete the question
-- (its answer rows cascade with it). Idempotent: re-running finds nothing
-- to copy and nothing to delete.
UPDATE `participation`
SET `departure_date` = (
  SELECT qa.`value`
  FROM `question_answer` qa
  JOIN `camp_question` q ON q.`id` = qa.`question_id`
  WHERE q.`prompt` LIKE '%stay until (strike)%'
    AND qa.`edition_id` = `participation`.`edition_id`
    AND qa.`membership_id` = `participation`.`membership_id`
    AND qa.`value` LIKE '____-__-__'
)
WHERE `departure_date` IS NULL
  AND EXISTS (
    SELECT 1
    FROM `question_answer` qa
    JOIN `camp_question` q ON q.`id` = qa.`question_id`
    WHERE q.`prompt` LIKE '%stay until (strike)%'
      AND qa.`edition_id` = `participation`.`edition_id`
      AND qa.`membership_id` = `participation`.`membership_id`
      AND qa.`value` LIKE '____-__-__'
  );
--> statement-breakpoint
INSERT INTO `participation` (`id`, `camp_id`, `edition_id`, `membership_id`, `status`, `departure_date`)
SELECT lower(hex(randomblob(16))), qa.`camp_id`, qa.`edition_id`, qa.`membership_id`, 'unknown', qa.`value`
FROM `question_answer` qa
JOIN `camp_question` q ON q.`id` = qa.`question_id`
WHERE q.`prompt` LIKE '%stay until (strike)%'
  AND qa.`value` LIKE '____-__-__'
  AND NOT EXISTS (
    SELECT 1 FROM `participation` p
    WHERE p.`edition_id` = qa.`edition_id`
      AND p.`membership_id` = qa.`membership_id`
  );
--> statement-breakpoint
DELETE FROM `camp_question` WHERE `prompt` LIKE '%stay until (strike)%';
