# Profile fields, conditional questions, and where answers live

> Task plan. Parent living plan: `plans/camptool.md`.
> Related: `plans/questions-unification.md` (the 2026-07-07 assessment — scope,
> surface, required-enforcement all landed; conditionals were deferred, and this
> is that deferral coming due), `plans/social-groups.md`.

## Goal

Four things the user asked for on 2026-08-22, after `/account` gained a home for
name and playa name:

1. **More profile fields** — phone, pronouns, emergency contact.
2. **Conditional questions** — "only ask X if Y", so people aren't walked
   through questions that don't apply to them.
3. **Answers on `/account`** — members can already change them at `/questions`,
   but `/account` is where people now look for "change what I said".
4. **Review/prune the live question list** — needs the camp's actual data.

Plus a design question the user raised: *"shouldn't our goal be that most things
are queryable?"*

## The queryability rule (settled 2026-08-22)

**Structure what another feature consumes; keep as questions what only humans
read.**

Question answers are not un-queryable today — `/questions/responses` lists them
and exports CSV. What a column buys that an answer doesn't is *joins,
validation, and other features reading it*. `attendee.arrival_date` earns one
because the arrival chart, the SAP matcher and the roster chips all read it.
"Why do you want to join" does not, because only a human ever reads it.

The cost is real and points the other way: this is an open-source core, so every
column one camp wants ships to every camp. That asymmetry is the whole reason
the question bank exists — the *capability* is core, the *questions* are data.

Consequence for the pending "under the main shade" ask: **a structured field**,
because the map should be able to filter and group by it. And the general answer
to "I want to slice by an answer" is to make *answers* filterable (a roster
filter over the question bank), not to promote questions to columns one at a
time. That serves every camp and needs no migration per question.

## Design

### 1. Profile fields

New columns on `membership` (camp-scoped, like `playa_name` — somebody in two
camps may share a phone but need not):

| Column | Type | Visibility |
|---|---|---|
| `pronouns` | text, null | Everyone in camp — that's the point of stating them |
| `phone` | text, null | Member+ in camp |
| `emergency_contact_name` | text, null | **Officers + self only** |
| `emergency_contact_phone` | text, null | **Officers + self only** |

Emergency contact is the sensitive one and drives three rules that must not be
skipped: it is never in a loader payload for a viewer who isn't an officer or
the person themselves; privacy/demo mode redacts all four; and nothing displays
it in a list — it belongs on a person's own card, where someone is looking for
it on purpose.

Stored as free text, deliberately. A phone-number type would need country
handling nobody has asked for, and pronouns are not an enum.

### 2. Conditional questions

`camp_question.show_if_question_id` + `show_if_value` (both nullable). A question
with `show_if` set is only asked when that other question's current answer
matches. Rules that make it safe:

- **A hidden question is never required.** Required-enforcement already blocks
  Next until in-scope required questions are answered; a hidden required
  question would be an unpassable gate with no visible cause. "In scope" gains
  "and currently shown".
- **A hidden question's stored answer is kept, not cleared.** Answering "yes",
  filling in the follow-up, then flipping to "no" should not destroy what you
  wrote — flip back and it's still there. Officer reports must therefore filter
  on the controlling answer too, not just presence.
- **One level only, and no cycles.** A question may not depend on one that
  itself depends on something (kept simple deliberately); a question may not
  depend on itself. Both enforced server-side at save.
- **Matching is string equality** against the stored text value, which is how
  every answer is stored (see `db/schema/question.ts`). For `multi_select`, the
  condition matches when the value is *among* the selections.

### 3. Answers on `/account`

A card listing this member's answers with their questions, read-only, linking to
`/questions` to change them. Read-only on purpose: `/questions` already renders
every question type properly and enforces required-ness, and a second editor is
the two-ledger mistake again.

### 4. Review/prune

Needs the camp's live question list, which isn't visible from here. Ask the user
to export `/questions/responses.csv` (or paste the question list) and go through
it together. Not blocked on any code.

## Steps

- [ ] Schema + migration: 4 `membership` columns, 2 `camp_question` columns.
- [ ] Privacy: add phone + emergency contact to the redaction vocabulary.
- [ ] `/account`: profile fields card (emergency contact clearly labelled as
      officer-visible), answers card.
- [ ] Members directory / roster: show pronouns; phone for member+; emergency
      contact on the person's card for officers only.
- [ ] Conditional questions: schema, evaluation helper (pure, tested), wizard +
      apply form + `/questions` all honouring it, required-enforcement update,
      officer UI to set the condition.
- [ ] `shade` structured field on `attendee` + map/roster filter.
- [ ] Roster filter over question answers (the general "queryable" fix).
- [ ] Tests: conditional evaluation (pure), e2e for visibility rules.

## Things not to do

- Don't promote questions to columns one at a time because someone wants to
  filter by one. Fix filtering.
- Don't clear a hidden question's stored answer.
- Don't let a hidden question block the wizard.
- Don't put emergency contact in any list view.
