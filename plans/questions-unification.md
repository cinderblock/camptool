# Questions & onboarding — unification design (assessment, 2026-07-07)

> Plan path: `plans/questions-unification.md`
> Parent plan: `plans/camptool.md`. Related: `plans/onboarding-feedback.md`,
> `plans/onboarding-ux-newbie-test.md`.

## Goal

Answer the user's design question: recruits who join **through existing campers'
invite links** should also be asked the previous-BM-experience questions (added
2026-07-07 to the public apply form only), and more broadly — do we have too
many categories of questions and no clear join flow that guarantees important
questions get answered?

## Inventory — every place a camper is asked something today

| Surface | What's asked | Storage | Who hits it |
|---|---|---|---|
| Public apply form `/c/:slug` | playa name + been-before, previous camp ×2, "why join" — **hardcoded** | `recruit_application` columns | cold applicants only |
| Invite link `/i/:token` | **nothing** — instant recruit membership | — | friend-invited recruits |
| Wizard `/start` profile ask | name, playa name — hardcoded | `user.name`, `membership.playa_name` | everyone |
| Wizard questionnaire asks (before/after Bringing) | **officer-configured** question bank, audience all/returning/recruit | `camp_question` → `question_answer` (per-edition) | everyone with a membership |
| Wizard rsvp / bringing / sharing / tickets | structured features | their own tables | everyone (season-gated) |
| Onboarding checklist | tasks to *do*, not questions | `onboarding_task`/`_completion` | members post-join |

## Diagnosis

**The categories are mostly fine.** Application gate / data questions / to-do
checklist / structured features (bringing, RSVP, tickets) genuinely are
different things with different storage. Collapsing them would be churn, not
clarity.

**The actual problems are three specific gaps, all in the question layer:**

1. **Two questioning systems.** Hardcoded form fields (apply form, profile) vs
   the configurable question bank. Every hardcoded question is invisible to the
   bank's audience/required/placement machinery — which is exactly why the
   previous-camp fields only exist at one door.
2. **What you're asked depends on which door you entered, not who you are.**
   Cold applicants answer the apply form's questions; invite-link recruits are
   asked nothing at the door. Both converge on the wizard afterwards — the
   wizard IS the "clear flow" (season-aware, per-ask completion, "Finish setup"
   nav badge) — but the door-specific questions never reach it.
3. **"Required" is not enforced.** `camp_question.required` renders an asterisk
   (`QuestionField.tsx`); the wizard's Next/Finish marks the questionnaire ask
   `done` regardless of unanswered required questions. Nothing "makes sure
   important questions are answered."

Two modeling limits keep forcing questions to be hardcoded instead of data:

- **No pre-membership answers.** `question_answer.membership_id` is NOT NULL, so
  the apply form (no membership yet) can't write to the bank → hardcoded columns
  on `recruit_application`.
- **No once-ever scope.** Answers are strictly per-edition (`loadAnswers`/
  `setAnswer` always pass `editionId`). "Previous BM experience" is a lifetime
  fact — asked via the bank it would re-ask every year. (`question_answer.
  edition_id` is already nullable in the schema, so the storage anticipates a
  camp-scoped answer; nothing uses it yet.)
- (Minor) **No conditional questions** — "only if you've been to BM before"
  can't be expressed; the apply form's checkbox-reveal is a hardcoded
  workaround. Self-gating copy ("If you've camped elsewhere before: …",
  optional) is a fine substitute until real conditionality is needed.

## Recommendation

### Zero-code fix available TODAY (data, not code)

Officers can add the previous-BM questions to the question bank right now via
`/questions` with **audience = recruit**: e.g. a boolean "Have you been to
Burning Man before?", a short_text "Which camp did you camp with (if any)?",
and a long_text "What did you like (or not) — what are you looking for here?".
Invite-link recruits then get asked in the wizard. Two saving graces make this
better than it sounds: recruits are promoted to member after their first year,
so audience=recruit ≈ asked once; and recruit-hood usually spans one edition,
so per-edition scoping doesn't actually re-ask. Downside: cold applicants who
answered on the apply form get asked again post-accept (mild duplication).

### Structural direction (the "rethink", scoped small)

Keep the categories; make the question bank the *single* question system and
let both doors share it:

1. **`camp_question.scope`: `per_edition` (default) | `once`.** Once-scoped
   answers store `edition_id = NULL` (column already allows it); the wizard
   questionnaire shows a `once` question only while unanswered. Unique index
   already covers (edition_id, membership_id, question_id) — verify SQLite
   treats NULL edition rows correctly for upsert (NULLs are distinct in unique
   indexes → the `onConflictDoUpdate` target won't fire for NULL edition; needs
   either a partial unique index on (membership_id, question_id) WHERE
   edition_id IS NULL, or app-level upsert).
2. **`camp_question.surface`: `wizard` (default) | `application` | `both`.**
   The apply form renders application-surfaced questions dynamically (recruit
   audience implied); answers go in an `answers` JSON column on
   `recruit_application` (no membership exists yet). On **accept**, copy them
   into `question_answer` keyed by question id — from then on there is exactly
   one record of what this person said, regardless of door.
3. **Enforce `required`.** The questionnaire ask can't be marked `done` while
   an in-scope required question is unanswered (Next validates; Skip stays
   allowed for the whole ask only if no required questions are pending). This
   plus the existing "Finish setup" pending-asks badge is the "make sure
   important questions are answered" guarantee.
4. **Migrate the 2026-07-07 hardcoded fields** (`previous_camp`,
   `previous_camp_notes`) into seeded `once`+`application|both` questions;
   keep truly structural profile fields (name, playa name) hardcoded — they're
   identity/profile data with real columns, not questionnaire answers.
5. **(Defer)** conditional questions (`show_if_question_id` + value). Use
   self-gating optional copy until something really needs it.

Officer review view: the recruits queue keeps showing application answers; a
member/recruit detail view should show their question-bank answers in one place
(check what `/questions` admin + members detail already show before building).

## Decisions (locked)

- **User (2026-07-07): go with the structural fix.** Also asked to document
  the joining flows → extended `docs/camp-lifecycle.md` (it already had the
  join flowchart) with "The question axes" + the two-doors section; linked
  from README's Design notes.
- **Answers import silently** (open question 2): a cold applicant's
  application answers become their question answers lazily on first
  wizard/`/questions` load (`importApplicationAnswers` — works for both accept
  paths, incl. better-auth invitation where no membership exists at accept
  time). The wizard shows `once` questions pre-filled, which doubles as
  confirmation — no separate re-confirm step.
- **`once` questions stay visible in the wizard, pre-filled** — NOT hidden
  once answered (the assessment originally said hide-while-unanswered; that
  would make a question vanish mid-session right after you blur the field).
  Not-re-asked = pre-filled + never blocks, not invisible.

## Implementation notes (landed 2026-07-07)

- Schema (**migration 0056_whole_spyke**): `camp_question.scope`
  ('per_edition' default | 'once') + `.surface` ('wizard' default |
  'application' | 'both'); `recruit_application.answers` (JSON
  {questionId: value}) + `.answersImportedAt`; partial unique index
  `question_answer_once_unique (membership_id, question_id) WHERE edition_id
  IS NULL`. Upsert uses `targetWhere` (same pattern as `attendee_member`).
  Migration also SEEDS the two previous-camp questions (short_text +
  long_text, audience recruit, scope once, surface both) for every existing
  camp; new camps' officers author their own (documented).
- The 2026-07-07 hardcoded apply-form fields (`previous_camp`,
  `previous_camp_notes`) are now LEGACY: columns kept + still displayed on
  `/recruits` for old applications, no longer written. `PlayaNameField`
  reverted to playa-name-only.
- Apply form renders application-surfaced questions via `QuestionField`'s new
  `onSave` prop (local-state mode, one hidden JSON field); server validates
  required + unknown ids. Wizard filters `surface !== 'application'`;
  `/questions` member view likewise (officers still manage all).
- Required enforcement: wizard questionnaire/extras steps disable Next/Skip
  until required in-scope questions pass `isAnswered` (type-aware: consent
  must be "true", multi_select non-empty, event_range half-filled ok);
  `resolveAsk` re-checks server-side (400). Locked years exempt.
- **Migration verified** by script on a fresh DB through the full 0000→0056
  chain: columns/index created, seeds land per camp after existing questions,
  partial index rejects duplicate lifetime answers while allowing an
  edition row alongside. (Script was a one-off; not kept.)

## Gotchas

- Shared-tree migration races: while building this, a peer session generated
  and pushed migrations 0054/0055 (roster/tickets) and left a dangling
  journal entry 0057 with no SQL file. My commit stages a journal ending at
  0056 (crafted via `git hash-object`/`update-index`, working tree untouched)
  so the dangling entry never reaches production, where the app migrates on
  boot and a missing file = crash. If you see 0057 reappear with a real file,
  that's the peer finishing — fine.
- Drizzle-kit generate reads `db/schema/index.ts`; the untracked `flag`
  schema was unexported at generate time (peer had already withdrawn it), so
  0056 contains only this feature's changes.

## Open questions for the user

1. ~~Direction~~ — structural fix chosen, landed.
2. ~~Silent import vs re-confirm~~ — silent import + pre-filled wizard.
3. Is "previous BM experience" a `once` question forever, or should returning
   members ever be re-asked (e.g. if they joined pre-CampTool)? (`once` +
   unanswered-until-answered handles the pre-CampTool case automatically —
   current behavior; revisit only if it bothers anyone.)
4. Future: should the "Finish setup" pending badge also re-surface when an
   officer adds a NEW required question after someone already resolved the
   questionnaire ask? (Today a resolved ask stays resolved; the new question
   is answerable on /questions but nothing nags.) Small follow-up if wanted.

## Progress log

- [x] 2026-07-07 — inventory + assessment written (this doc). No code changes.
- [x] 2026-07-07 — user chose the structural fix (+ document joining flows).
- [x] 2026-07-07 — schema + migration 0056 (scope/surface/answers/partial
      index + seeded previous-camp questions), verified on a fresh DB.
- [x] 2026-07-07 — apply form → dynamic application questions; answers held
      on the application and imported on membership; hardcoded previous-camp
      fields retired (legacy display kept).
- [x] 2026-07-07 — wizard + /questions surface filtering; required-question
      enforcement (client + server); officer admin gets Scope/Surface selects.
- [x] 2026-07-07 — docs: camp-lifecycle.md question-axes + two-doors
      sections; README link. typecheck green (only pre-existing peer-thread
      error in members.tsx, not this work); biome green on changed files.
- [ ] Browser-test the golden path (apply with answers → review shows them →
      accept → wizard shows imported answers; invited recruit gets asked the
      seeded questions; required question blocks Next).
