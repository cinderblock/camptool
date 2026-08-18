# Prospects — an officer CRM for people the camp is talking to

> Plan path: `plans/prospects-crm.md`
> Parent plan: `plans/camptool.md` (Phase 4 — Operations)

## Goal

Three asks from one thread (2026-08-17), in increasing size:

1. **See who invited who on the Members page.** The data is already recorded and
   has never been displayed.
2. **See members' answers to the camp questionnaire.** Officers can author
   questions and campers answer them, but *nobody* can read the answers — not
   even the officer who wrote the question. A pure gap, not a new feature.
3. **A CRM for prospective campers.** When an officer gets a message on
   Facebook (or email, or Discord, or in person), they can paste it — plus a
   link back to the original — against a *prospect*, and every other officer
   can see the whole conversation history with that person. Usually one officer
   shepherds a prospect; when the same person has been talking to several
   officers separately, the duplicate prospect records **merge**.

## Decisions already made (don't re-ask)

Locked by Cameron in the opening exchange:

- **The log follows the person.** A prospect links to their `membership` once
  they join, and officers can keep logging interactions afterwards. One thread
  per human, spanning prospect → recruit → member. *Not* a funnel-only tool that
  archives on join.
- **One pipeline with the existing `/recruits` queue.** A public application
  from `/c/:slug` matches an existing prospect by email, or auto-creates one, so
  there is a single list of everyone the camp is in contact with. The
  accept/reject queue on `/recruits` stays where it is.
- **Named "Prospects", route `/prospects`.** (Not "Outreach", not "CRM".) The
  entity in the schema is `prospect`.
- **Officer-only**, per the ask ("all officers can see the interactions other
  officers have had"). Also per the standing private-first rule (parent plan
  decision #0): no public surface, ever. This one is more sensitive than most —
  it holds unflattering candid notes about people who have not consented to
  anything.
- **Bodies reuse the wiki/FAQ markup format**, so an officer can paste a
  *screenshot* of the message as well as its text, and can deep-link
  `[[/members]]` etc. `MarkupTextarea` + `camp_image` already exist
  (`plans/pictures-in-bodies.md`); this is reuse, not new machinery.

## Environment / context

- Repo `C:\Users\camer\git\Personal Projects\CampTool`, branch `master`.
- Migrations are at **0073**; this work adds **0074**.
- Shared working tree — other threads have uncommitted changes in
  `app/lib/training.ts`, `db/schema/{auth,schedule,training}.ts`. **Stage only
  files this thread touched.**
- Feature registry: `app/lib/features.ts` (catalog, code) + `camp_feature`
  (state, data). New key → add to `FeatureKey`, `FEATURES`, `ROUTE_FEATURES`.

## What already exists (don't rebuild)

- `membership.invitedByMembershipId` — the invite-tree edge, written on invite
  redemption at `app/routes/i.$token.tsx:129`. Never rendered anywhere except as
  a pre-fill for the "who invited you" question (`loadInviterName`).
- `membership.viaInviteId` — which *link* was redeemed. An `open` (camp-door)
  invite records no personal inviter but still records the door, so a member can
  show "via the 2026 art-crew link" with no named inviter.
- `camp_invite` (`db/schema/recruit.ts`) — tokenized invites, with a
  `promoteAttendeeId` precedent for "redeeming this link adopts that other row".
  The prospect→member link copies that pattern.
- `app/lib/merge.server.ts` — merging is **generic**: it discovers every FK
  pointing at a target table via `PRAGMA foreign_key_list` and re-points them,
  then deletes the stale row. A new table gets merge support for free; a new
  *mergeable entity* needs ~20 lines wrapping the same primitive.
- `app/components/MarkupTextarea.tsx` + the wiki body renderer — markdown
  subset, `[[Page]]` / `[[/route|label]]` links, picture paste/drop/upload.
- `question_answer` (`db/schema/question.ts`) — answers already stored, edition-
  scoped, with `once`-scoped lifetime answers carrying `edition_id = NULL`.

## Plan / steps

### Step 1 — Invited by, on the Members page ✅

An "Invited by" column resolving `invitedByMembershipId` → that member's name,
falling back to the invite's `note`/kind when only `viaInviteId` is set, and
"—" when neither (founder, officer-added, public application). Cheap because
the roster rows are already loaded — resolve names from the in-memory map, no
extra query for the inviter, one small query for the invite labels.

### Step 2 — Officer view of questionnaire answers ✅

`/questions` gains an officer-only **Responses** section: per question, who
answered what, for the active year (plus `once`-scoped lifetime answers, which
are year-independent). Needs a per-question breakdown *and* a per-member one —
the two questions an officer actually has are "what did everyone say to Q?" and
"what did Alex say to everything?". Read-only. Respects the same privacy
redaction the rest of the app uses.

### Step 3 — The `prospect` CRM

Schema (migration 0074), all camp-scoped, **not** edition-scoped — a
conversation spans years:

- **`prospect`** — the person. `name` is the only required field: a prospect can
  legitimately be nothing but "Jenny from the FB thread". Optional `playaName`,
  `email`, `phone`, `notes` (a running summary, distinct from the log).
  `status` ∈ `lead | talking | invited | applied | joined | passed | declined |
  stale`. `ownerMembershipId` = the officer shepherding them (nullable =
  unclaimed). `nextFollowUpAt` = "come back to this" date — the thing that makes
  a CRM a CRM rather than a notes pile. `membershipId` set on join,
  `recruitApplicationId` set on match.
- **`prospect_handle`** — (kind, value, label). Kinds: facebook, instagram,
  discord, email, phone, signal, telegram, website, other. A separate table, not
  a JSON blob, because matching an incoming application against
  "do we already know this person" is a lookup.
- **`prospect_interaction`** — the log. `channel`, `direction`
  (inbound/outbound/note), `occurredAt` (when it *happened*, distinct from when
  it was logged), `subject`, `body` (wiki markup — screenshots welcome),
  `sourceUrl` (permalink back to the FB post / Discord message), `externalRef`
  (an email `Message-ID`, or free text), `counterparty` (the "to"/"from" for
  email), `authorMembershipId`.

Merge: `mergeProspects(campId, survivorId, staleId)` over the existing
`repoint` primitive — interactions and handles move, contact fields fill in
where the survivor is blank, the earliest `createdAt` wins, and the survivor
keeps its own owner/status unless it has none.

Promotion: an officer creates a personal `camp_invite` **from the prospect
card**; redeeming it stamps `prospect.membershipId` + `status = joined`, exactly
as `promoteAttendeeId` adopts a guest today. That needs a `prospectId` column on
`camp_invite`.

Feature key `prospects` (default **off**), officer-only in the route *and* the
nav. Nav badge = prospects whose `nextFollowUpAt` is due.

## Findings / gotchas

- **Every ALTER-added FK column in this repo lost its `ON DELETE` rule.**
  SQLite's `ALTER TABLE … ADD COLUMN … REFERENCES x(id)` takes no `ON DELETE`
  clause, so drizzle-kit emits a bare reference that defaults to NO ACTION —
  `attendee_id` on three tables and `promote_attendee_id` on `camp_invite` all
  went in that way, and migration 0065 is the hand-written repair. Migration
  0074's generated `ALTER TABLE camp_invite ADD prospect_id` was replaced with a
  full 12-step table rebuild for the same reason. Verified on a throwaway DB:
  `PRAGMA foreign_key_list(camp_invite)` now reports
  `prospect_id->prospect ON DELETE SET NULL`, and `foreign_key_check` is clean.
- **Module-scope use of a `.server` import breaks the client build, not the
  typecheck.** `const applies = questionApplies` at module scope in
  questions.responses.tsx typechecked fine and failed `bun run build` with
  "Server-only module referenced by client" — React Router strips server code
  from `loader`/`action` only. `questionApplies` moved to the pure
  `questions.ts`. Any pure helper a component calls while *rendering* must not
  live in a `.server` file.
- **React SSR breaks naive substring assertions.** `{a} of {b}` in JSX arrives
  as `1<!-- --> of <!-- -->1`, because React inserts a comment between adjacent
  text expressions — so `html.includes("1 of 1")` fails against perfectly
  correct markup. `e2e/question-responses.ts` strips `<!-- -->` before matching;
  do the same in any new suite that asserts on rendered text.
- **`privacy-coverage.test.ts` matches the literal text `redact(privacy`.** A
  `redact(\n  privacy,\n  …)` that biome reformatted onto separate lines fails
  the guard even though the route genuinely redacts. Bind the payload to a
  variable first so the call fits on one line.
- **The generate was safe despite a dirty tree.** The other threads' changes to
  `db/schema/{auth,schedule,training}.ts` turned out to be line-ending churn
  with a zero-content diff, so the usual "comment out their `export *`" dance
  (see the drizzle-generate memory) wasn't needed. Worth re-checking with
  `git diff --stat` rather than assuming either way.

- **`questions.tsx` really has no officer answer view.** Verified: the loader
  calls `loadAnswers({ membershipId: active.membership.id })` and nothing else
  reads `question_answer` outside `asks.server.ts` (the to-do count) and
  `questions.server.ts` (own answers). The officer-facing surface is the
  *editor* only. So this is new UI, not a broken link.
- **`campInvite` can't FK to `membership` in the other direction.**
  `membership.viaInviteId` is a plain id with no FK because `recruit.ts` imports
  `camp.ts` and a real reference would be a module cycle. Adding
  `campInvite.prospectId` is fine (recruit.ts can import the new prospect table);
  going the other way is not.
- **Merge is FK-driven, so table order matters at delete time**, and
  `UPDATE OR IGNORE` silently drops rows that would violate a unique index.
  Prospect handles need a unique (prospectId, kind, value) so a merge that
  brings duplicate handles collapses them instead of erroring.

## Progress log

- [x] Read the codebase; confirmed what exists vs. what's missing.
- [x] Locked the three design questions with Cameron.
- [x] Step 1 — invited-by column. (commit e429185)
- [x] Step 2 — officer responses view + CSV. (commit e429185)
- [x] Step 3 — prospect schema + migration 0074, verified on a throwaway DB
      (chain applies, 0 FK violations, `camp_invite` rebuilt so `prospect_id`
      carries `ON DELETE SET NULL`).
- [x] Step 3 — `/prospects` list + `/prospects/:id` thread, feature key
      `prospects` (default off, officer-only), nav link with a needs-a-nudge
      badge.
- [x] Step 3 — merge, application matching, invite promotion.
- [x] `mergeProspects` exercised against a real migrated DB: both logs survive
      and re-sort chronologically, a duplicate handle collapses instead of
      erroring, blank contact fields fill from the loser, the further-along
      status wins, `created_at` takes the earlier date, the follow-up takes the
      sooner one, notes are joined, `camp_invite.prospect_id` re-points, 0 FK
      violations.
- [x] typecheck / lint / build / 235 unit tests green; committed.

## Still to do (not built)

- ~~Browser E2E.~~ **DONE, over real HTTP** — no browser needed, so both run
  under bun like `e2e/faq.ts`:
  - **`e2e/prospects.ts` 36/36** (`bun run e2e:prospects`). Covers the opt-in
    bounce; officer-only *even when the feature is fully ON*, and in the action
    as well as the loader; create-from-a-name-alone; log-advances-a-lead;
    scheme-less source link normalised to https; duplicate handle refused;
    **merge** keeping both conversations and collapsing the duplicate handle;
    **invite promotion** stamping the record on redemption; **one pipeline**
    (an application matching the existing prospect, with no second record);
    and cross-camp isolation on both read and write.
  - **`e2e/question-responses.ts` 18/18** (`bun run e2e:responses`). Covers
    officer-only; answers appearing; lifetime (`once`-scoped) answers surfacing
    in the year; archived questions still readable with their prompt; audience
    gating (`1 of 1` on a recruit-only question, `2 of 3` on an open one);
    the yes/no tally; the CSV quoting an embedded comma **and** newline, and
    saying `n/a` rather than blank for a question someone was never asked; and
    the Members invite tree, including naming the *link* for an open invite.
  - Both greps of the dev-server log were clean, which is the check that
    matters — an SSR throw still returns HTTP 200 (see the memory), so each
    suite also asserts a marker only server-rendering produces.
- ~~Not deployed.~~ **DEPLOYED** — commit `cd3db57`, "Deploy to firefly" green
  (its "Verify the migration chain" step included), `/_version` confirms
  `cd3db57` is serving. Before pushing, migration 0074 was applied to a
  `VACUUM INTO` copy of the live DB: no row loss in any table, `camp_invite`'s
  one row byte-identical through the rebuild, `camp_invite_token_unique`
  preserved, `integrity_check` ok, `foreign_key_check` clean. Nothing changes
  for the camp until an admin switches the feature on at `/settings`.
- **A prospect can't be logged against from the member side.** The decision was
  "the log follows them", and it does — `prospect.membership_id` links them and
  the thread stays readable — but there's no entry point from `/members` yet.
  A link from a member's row to their prospect thread is the obvious follow-up.
- **No Discord/email ingestion.** Every interaction is hand-pasted, which is
  the ask. Auto-capturing Discord DMs would need the gateway process the parent
  plan deliberately avoids.

## Things not to do

- **Don't give prospects any public surface.** No "apply on behalf of", no
  shareable prospect page. The camp's private-first rule (parent plan decision
  #0) is at its strongest here: these are candid notes about non-consenting
  third parties.
- **Don't show prospects to members.** Officer-only in the loader AND the
  action, not just the nav — the standing pattern for gated routes.
- **Don't reuse `recruit_application` as the prospect record.** It is the
  artifact of a *submitted form*; a prospect frequently has no form and no email.
- **Don't use `title=` attributes** for the channel/source affordances (global
  rule — invisible on touch).
- **Don't stage other threads' files** (`app/lib/training.ts`,
  `db/schema/{auth,schedule,training}.ts` were already dirty).
