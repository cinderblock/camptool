# Camp FAQ — a searchable Q&A list, officer-answered, deeply linkable

> Task plan. Parent living plan: `plans/camptool.md` (read that first).
> Siblings: `plans/camp-wiki.md` (the body format + `[[…]]` links this reuses),
> `plans/camp-features.md` (the off/preview/on gating this rides on).
> Plan path: `plans/camp-faq.md`

## Goal (user ask, 2026-08-16)

> "We need an FAQ option. most see it as a searchable Q&A list. admins can edit.
> should be able to link to other sections of camptool, deeply, especially wiki"

Four requirements, in the user's order:

1. **Optional** — a camp feature in the existing registry, default off.
2. **Searchable Q&A list** — that's the shape most people see. Not a document,
   not a forum: questions you scan, answers you expand.
3. **Admins can edit** — a curated, authoritative surface, unlike the wiki.
4. **Deep in-app links, especially wiki** — an answer's job is usually to point
   somewhere ("see [[Fire safety]]", "request one on [[/tickets|Tickets]]").

## Decisions already made (don't re-ask)

Asked and answered by Cameron, 2026-08-16, before any code:

1. **Who edits: officers and admins.** "Admins" in the ask was colloquial. This
   matches every other authoring surface (announcements, documents, training
   sign-offs). Members and recruits read.
2. **Yes to an ask queue.** A member who doesn't find their answer submits the
   question; officers see a pending queue and answer it, which publishes it.
   This is what keeps a FAQ from going stale — the alternative (officers guess
   what people want to know) is how FAQs die.
3. **Categories + search.** Officer-defined categories, each collapsible, with
   a live search filtering across question *and* answer text.

Decided here, and worth not re-opening:

4. **Camp-scoped, not edition-scoped** — like the wiki and `camp_document`.
   "How do I get to the playa" is not a 2026 fact.
5. **Answers are written in the wiki body format** (`app/lib/wiki.ts`) —
   the same markdown subset and the same `[[…]]` link syntax. Not a second
   markup. This is what delivers requirement 4 for free.
6. **Recruits may ask, but not edit.** Deliberately looser than the wiki's
   member+ write gate: an applicant is exactly the person with questions, and a
   submission isn't a publication — an officer still has to answer it.
7. **No `requires: ["wiki"]`.** FAQ stands alone. `[[/tickets|…]]` in-app links
   work with the wiki off; wiki-page links degrade to plain text (see below).

## Design

### Feature registry

Key `faq`, label "FAQ", **not** a starter feature — every camp opts in.
Added to `ROUTE_FEATURES` so the preview banner works. Because the picker in
`appLinkTargets()` is generated from `FEATURES`, `/faq` becomes a one-click link
target from the wiki editor the moment the key exists.

Naming note: the registry already has a `questions` key — that is the per-year
**questionnaire** (officers ask, campers answer). This is the inverse (campers
ask, officers answer) and must never be conflated with it in code or copy.

### Schema — `db/schema/faq.ts`

**`faq_category`** — id, campId, name, slug, position, createdAt.
Unique `(camp_id, slug)`. Entries with a null category fall into a trailing
"General" bucket, so a camp never has to create a category to write an answer.

**`faq_entry`** — the whole lifecycle in one table:

| column | why |
|---|---|
| `slug` | stable deep-link address, unique per camp. `/faq/how-do-i-get-a-ticket` survives re-wording the question, exactly like a wiki page's slug |
| `question` / `answer` | answer is the wiki body format, `""` while pending |
| `status` | `pending` \| `published` \| `archived` |
| `category_id` | nullable → General; `ON DELETE SET NULL` so deleting a category never deletes answers |
| `position` | manual order within the category |
| `asked_by_id` | set when it came from the queue — powers "you asked this" |
| `answered_by_id`, `answered_at` | who published it, and when |

**A pending question is just an unanswered entry.** Modelling submissions as a
separate table was considered and rejected: the officer flow is "edit the
question's wording, write the answer, file it under a category, publish", which
is *editing that row*, not copying one row into another. One table means no
sync, no orphans, and the deep link an officer shares is the same id the asker
followed.

### Statuses

- **`pending`** — visible to officers (a queue at the top of `/faq`) and to the
  asker (as "you asked this — waiting on an officer"). Nobody else.
- **`published`** — the Q&A list everyone sees.
- **`archived`** — withdrawn or declined. Hidden from members, kept for officers
  rather than deleted, so "we decided not to answer that" is recoverable.
  Hard delete stays available to officers for junk.

### Body format + links — the requirement-4 machinery

Answers are parsed with `parseWikiBody()` and rendered with `<WikiBody>` —
React elements, never `dangerouslySetInnerHTML` (multi-tenant SSR; the text is
member-authored once the ask queue is in play).

That buys three link kinds in one syntax:

- `[[Fire safety]]` → the wiki page. **The "especially wiki" requirement.**
- `[[/tickets|request one here]]` → any in-app route, deep.
- bare `https://…` → external, `rel="noopener noreferrer"`.

**Both editors get a two-group "Insert a link to…" picker**: *CampTool* (the
camp's enabled features, from `appLinkTargets()`) and *Wiki pages* / *FAQ
answers* (real rows, by title). Linking deeply is a click, not a memorized path.
The wiki editor gains the FAQ group; the FAQ editor gains the wiki group. That
symmetry is the point — the two features are each other's primary destination.

**Wiki off?** `<WikiBody wikiEnabled={false}>` renders wiki-target links as
plain dimmed text instead of a link into a gated route. A camp with FAQ on and
wiki off never shows its members a dead end.

### Surfaces

- **`/faq`** — search box; officer pending queue; categories, each an accordion
  of questions; "Ask a question" for everyone; officer controls (new entry,
  edit, reorder, archive, manage categories).
- **`/faq/:slug`** — one entry, standalone. What a deep link resolves to and
  what "Link to this answer" copies.
- Nav link "FAQ", gated, badged with the pending count for officers.

Editing happens in a modal on `/faq`, not a separate route: an answer is a
paragraph or two, not a wiki page. The modal carries the textarea, the link
picker, and a live preview.

## Phases

1. Schema + migration + `app/lib/faq.ts` (pure) + `faq.server.ts` + unit tests.
2. Feature registry, routes, nav link.
3. `/faq` index (search, categories, accordion, ask box, officer queue +
   editor) and `/faq/:slug`.
4. Cross-linking: `WikiBody` `wikiEnabled` prop; FAQ group in the wiki editor's
   picker; wiki group in the FAQ editor's picker.
5. Typecheck / lint / test / build green, E2E over HTTP, commit.

## Things not to do

- Don't conflate `faq` with the existing `questions` questionnaire feature.
- Don't invent a second markup — answers are wiki-format, full stop.
- Don't render an answer through `dangerouslySetInnerHTML`.
- Don't make FAQ edition-scoped.
- Don't add `requires: ["wiki"]` — FAQ must stand alone.
- Don't add a public FAQ surface. CampTool is private-first (see the parent
  plan's locked rule); every route lives inside the auth-required shell.
- Don't use `title=` attributes.

## Progress log

- [x] 2026-08-16 — three design questions asked and answered; plan written.
- [x] Phase 1 — `db/schema/faq.ts` (`faq_category`, `faq_entry`), migration
      **`0072_flaky_thanos`** (pure create, no unrelated churn), `app/lib/faq.ts`
      (status guard, slug, term-wise search, category grouping) +
      `faq.server.ts`. 20 unit tests in `app/lib/faq.test.ts`.
- [x] Phase 2 — `faq` feature key + `ROUTE_FEATURES`, both routes registered,
      nav link with an officer-only pending badge (the layout loader counts
      pending entries only for officers who can see the feature).
- [x] Phase 3 — `/faq` (search, category groups, per-entry disclosure, ask box,
      officer queue / editor modal / archive / reorder / category management
      incl. in-place rename) and `/faq/:slug`.
- [x] Phase 4 — `WikiBody` gained `wikiEnabled`; the link picker became the
      shared `components/MarkupTextarea.tsx` used by BOTH editors, with
      `linkSnippet()` in `~/lib/wiki`. FAQ editor offers wiki pages; wiki editor
      offers published FAQ answers.
- [x] Phase 5 — typecheck + lint + build green; 194/194 unit tests;
      `db:verify` 73 migrations / 62 tables; **`e2e/faq.ts` 33/33** and the
      existing `e2e/wiki.ts` 17/17 re-run after the editor refactor.

**E2E gotcha worth keeping:** the ask box's placeholder is the same example
question the test publishes ("Where do I park if I arrive after dark?"), so a
substring assertion on that wording passes on every page whether or not the
entry rendered. Assert on the entry's permalink (`/faq/<slug>`) instead.

**Bug found AFTER the first deploy, fixed in a follow-up — read this before
adding anything to a picker.** `appLinkTargets()` listed `/wiki` in its hardcoded
core set *and* generated it again from the feature registry, so the picker got
two options with the same value. Mantine's `Select` **throws** on duplicate
option values; React caught it during SSR, fell back to client rendering, and
the page still returned **HTTP 200** with the picker silently missing. Every
route-level assertion passed. It only surfaced as
`error: [@mantine/core] Duplicate options are not supported. Option with value
"route:/wiki"` in the dev server's **stdout**, which no check was reading.

Three lessons, all now enforced:

- **Read the server log, not just the status code.** An SSR throw degrades to a
  200. A green e2e run over a log full of errors is a false negative.
- `appLinkTargets()` now dedupes by path and no longer hardcodes `/wiki` —
  the wiki is a gated feature like any other, so it also stopped being offered
  to camps with the wiki turned off (a second, quieter bug).
- Covered by unit tests in `app/lib/wiki.test.ts` (it had none) and by
  e2e check 13b, which asserts the picker's own markup is in the SSR HTML.

## Follow-ups worth considering (not built)

- A wiki `WIKI_SUBJECTS` entry for `faq`, so a wiki page could be *tied* to an
  answer rather than merely linking at it. Deliberately skipped: the link is
  what the ask needed, and a tie implies a "related questions" surface nobody
  has asked for yet.
- Answer revisions. The wiki keeps history because anyone can edit; the FAQ is
  officer-authored, so there is no equivalent blast radius yet.

## Open questions for the user

None outstanding.
