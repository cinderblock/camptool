# Member removal + arrival date onboarding + "on or after" SAPs

> Task plan. Parent living plan: `plans/camptool.md`.

## Goal

Three user asks (2026-07-03):
1. Admins need a way to remove people from the camp.
2. Initial onboarding must collect the desired **arrival date**; if it's before
   gate-open, ask whether a Setup Access Pass is needed and **auto-request** one.
3. SAP assignment should use **"on or after" dates** — a pass admits you on or
   after its date, so an earlier-dated pass covers a later arrival.

## Decisions

- **Removal = hard delete of the membership row** (direct `db.delete`, NOT
  `auth.api.removeMember` — the better-auth ACL only grants `member: delete` to
  admin, and our rank check is the real authorization, same pattern as invite
  redemption). Officer+ may remove only members they strictly outrank; never
  self. FK cascades clear their per-year rows (participation, answers, passes,
  wizard asks, occupancy); owned map/inventory items go `set null` → communal/
  unclaimed. A Mantine confirmation modal spells out the consequences.
  `resolveActiveCamp` already degrades gracefully for a removed member's stale
  session (falls back to their other camps / the no-camp screen).
- **Arrival date lives on `participation`** (`arrival_date`, ISO `YYYY-MM-DD`,
  nullable) — it's per-member-per-year, exactly what participation models. Per
  the Airtable-mapping principle: route structured data to the real feature,
  not the question bank.
- **SAP requests are unbound**: `setup_pass.pass_date_id` becomes nullable. A
  request row has NULL date; the officer picks the "on or after" date row at
  grant time (quota-enforced as before). `setup_pass_date` rows now MEAN "the
  camp holds N passes valid on or after this date". One active (requested or
  granted) pass per member per edition, enforced in code (the unique index
  treats NULL dates as distinct, so schema can't).
- The wizard's SAP prompt + gate-open math reuse the existing BRC-approximate
  helpers (`eventStartFor` / `eventWindowFor`) that the wizard already uses for
  all events — no new event-type gating (consistent with current behavior).

## Steps

- [x] Schema: `participation.arrival_date`; `setup_pass.pass_date_id` nullable
      (+ header comment rewrite). Migration **0039_abnormal_war_machine**.
- [x] `wizard.server.ts`: `setParticipation` + `loadWizardState` carry
      `arrivalDate`.
- [x] `passes.tsx`: on-or-after copy; member request form loses the date picker
      (one active pass each, optional note, arrival shown); officer pending
      queue shows arrival + a date Select at grant time (defaults to the latest
      date that still covers their arrival); `approvePass` takes `passDateId`;
      `grantPass` resolves an existing unbound request.
- [x] `start.tsx`: arrival DateInput in the RSVP step (event-window-bounded,
      saves via the rsvp intent, shown when status is coming/maybe);
      pre-gate-open arrival ⇒ SAP prompt with request button
      (`requestSetupPass` intent, idempotent) + status once requested/granted
      (warns if the granted date is after their arrival).
- [x] `members.tsx`: `removeMember` intent + confirm modal.
- [x] typecheck + build + biome green; migration verified on a DB copy.
- [x] Update `plans/camptool.md`; commit (staged only this task's files — the
      tree has other threads' modified migration snapshots); push + watch CI.

## Findings / gotchas

- The tree has uncommitted `db/migrations/meta/0011–0023_snapshot.json`
  modifications from another thread — left unstaged.
- Migration numbering: latest committed is 0038, so this is **0039**. The
  `setup_pass` rebuild (SQLite can't drop NOT NULL in place) preserves rows via
  the usual `__new_` copy; verified on a VACUUM-INTO copy of the dev DB (both
  columns correct, indexes recreated, `foreign_key_check` clean).
- One active pass per member is enforced **in code** (`activePassFor`), not by
  the `(pass_date_id, membership_id)` unique index — SQLite treats NULL as
  distinct there, so unbound requests can't be constrained by it.
- Legacy `requested` rows that already carry a `pass_date_id` (pre-0039 data)
  still work: the officer queue preselects that date if it has quota room.

## Verification (2026-07-03)

- typecheck + build + biome green.
- **E2E over HTTP** against a scratch dev server (port 3100, fresh DB, real
  better-auth signups + session cookies; camp/edition/memberships seeded
  directly): all 19 assertions passed — rsvp persists `arrival_date`; bogus
  date 400s; `requestSetupPass` creates ONE unbound row and is idempotent;
  `approvePass` without a date 400s, with a date grants + binds; quota
  overflow 409s; re-request while holding a pass 409s; recruit can request;
  non-officer removal 403s; self-removal 400s; admin removal deletes the
  membership AND cascades (participation + setup_pass rows gone).
- NOT browser-tested (modal, DateInputs, selects render/interaction). Worth a
  click-through on the live deploy: /start arrival + SAP prompt, /passes
  officer grant picker, /members Remove modal.
