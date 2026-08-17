# Camp wiki — member-editable pages, linkable to anything

> Task plan. Parent living plan: `plans/camptool.md` (read that first).
> Sibling: `plans/camp-features.md` (the off/preview/on gating this rides on).
> Plan path: `plans/camp-wiki.md`

## Goal (user ask, 2026-08-16)

1. A **new optional section** — a camp wiki — that **any member can edit**.
2. Pages are for **arbitrary things** (free-form knowledge base).
3. A page can be **tied to a specific thing in the app** — notably a structure
   on the map. Math Camp's Sierpinski pyramid "deserves a linked wiki page".
4. It should be **easy for wiki pages to link to other CampTool features**.

"Optional" = a camp feature in the existing registry (`app/lib/features.ts`),
default **off**, flipped on per camp at `/settings`. Not a new gating concept.

## Environment / context

- Repo `C:\Users\camer\git\Personal Projects\CampTool`, branch `master`.
- Feature key `wiki` is already in the registry + `ROUTE_FEATURES`.
- Migration for `wiki_page` / `wiki_revision` was generated as **0070**
  (`0070_mighty_hydra.sql`) and has **not** been applied to any DB
  (`data/camptool.db` untouched since 2026-08-10; the migrator only runs on app
  startup — `bun run db:migrate` does not work here, see the parent plan).

## Provenance — this started as a duplicate thread (resolved)

T3 Code dispatched this same prompt to **two** sessions at once:
`8436414a-…` (this one) and `1582f01f-…` (AI title "Add optional editable
section to camp wiki", enqueued 4s later). The peer wrote a first-pass skeleton
into the shared tree, then went idle. **The user was asked to close that
thread.** This thread owns the feature and builds on that skeleton.

Defects inherited from the skeleton, all to be fixed here (do not re-introduce):

- **`@tabler/icons-react` is imported but is not a dependency** and is used
  nowhere else in the app — the build would fail. The app's idiom is plain text
  glyphs / Mantine defaults (see `documents.tsx`).
- **`title=` attributes** on the ActionIcons — banned outright by the user's
  global rules (invisible on touch). Use visible labels.
- `created_by_id` / `edited_by_id` are `NOT NULL` **and** `ON DELETE SET NULL` —
  contradictory; deleting a user would fail. Make them nullable (matches
  `camp_document.created_by_id`).
- Only a plain index on `(camp_id, slug)`; uniqueness is enforced by a racy
  read-then-insert. Needs a **unique** index.
- `.orderBy((p) => p.updatedAt)` is not the drizzle select-builder API.
- `window.confirm` for delete; the app uses Mantine modals.
- `wiki_revision` is created but never written to.

## Design

### Feature registry

`wiki` key, label "Wiki", **not** a starter feature (new camps start off;
existing camps were grandfathered on by migration 0060's DML — which predates
this key, so existing camps get the registry default `off` too. Fine: it's a
new feature, every camp opts in deliberately).

### Schema — `db/schema/wiki.ts` (CAMP-scoped, not edition-scoped)

Wiki knowledge persists across years, like `camp_document`. Three tables:

- **`wiki_page`** — id, campId, slug, title, body, createdById?, updatedById?,
  createdAt, updatedAt. **Unique `(camp_id, slug)`**.
- **`wiki_revision`** — every save snapshots the PREVIOUS body: id, pageId,
  campId, title, body, editedById?, editedAt, summary?. Gives history + restore.
- **`wiki_link`** — the "tied to a specific thing" join: id, campId, pageId,
  subjectType, subjectId, createdById?, createdAt. Unique
  `(page_id, subject_type, subject_id)`; index `(camp_id, subject_type,
  subject_id)` for the reverse lookup ("does this thing have a page?").

### Subjects — what a page can be tied to (`app/lib/wiki.ts`, client-safe)

`subjectType` is an open text column with a code registry, so new subject kinds
cost one entry, not a migration:

| subjectType | subjectId | why |
|---|---|---|
| `structure_kind` | `Kind.value` (e.g. `sierpinski-pyramid`) | **the Sierpinski case.** Ties to the KIND, so it survives the yearly re-commit — map objects are recreated each edition, the kind is forever |
| `map_object` | `map_object.id` | one specific placed thing this year |
| `gathering` | `gathering.id` | a work party / meeting |
| `offering` | `offering.id` | a talk/workshop the camp gives |
| `training` | training id | how to earn a sign-off |
| `document` | `camp_document.id` | notes wrapping a shared link |

Locked: **structure_kind is the primary map tie**, `map_object` is the
per-instance escape hatch. A kind-linked page shows on every placed instance.

### Body format — a safe markdown subset, no new dependency

Rendered to **React elements, never `dangerouslySetInnerHTML`** (the app is
multi-tenant SSR; member-authored HTML is not going near innerHTML). Subset:
headings, bold/italic/code, bullet + numbered lists, blockquotes, fenced code,
horizontal rules, paragraphs, and links.

**One link syntax for everything** — `[[target]]` or `[[target|label]]`:

- `[[Fire safety]]` → another wiki page by title/slug. Missing page renders
  dimmed with a "create it" affordance (classic red-link).
- `[[/map|the camp map]]` → any in-app route. An **"Insert link" picker** in the
  editor lists the camp's *enabled* features by label, so linking to other
  CampTool features is a click, not a memorized path.
- Bare `https://…` autolinks; external links get `rel="noopener noreferrer"`.

### Permissions

Any **member+** creates and edits any page (the ask: "any member can edit").
Recruits read-only. **Officers** delete pages and restore revisions. Every save
writes a `wiki_revision`, so "any member can edit" is safe — nothing is lost.

### Surfaces

- `/wiki` — index: pages grouped, search, "New page".
- `/wiki/:slug` — read view + linked-subject chips + backlinks.
- `/wiki/:slug/edit` — textarea + link picker + live preview + history.
- **Map side panel** — selected object shows its kind's page (or "Start one").
- Nav link "Wiki", gated, next to Documents.

## Phases

1. Schema (fix + `wiki_link`), regenerate migration 0070, `app/lib/wiki.ts`
   (subject registry + parser/renderer), unit tests for the parser.
2. Routes rewritten clean (no tabler, no `title=`), revisions written + history
   + restore, nav link.
3. Map integration (side-panel link both ways) + the feature-link picker.
4. Typecheck/lint/build green, E2E over HTTP, commit, update parent plan.

## Things not to do

- Don't add `@tabler/icons-react` just to keep the skeleton's imports.
- Don't use `title=` attributes anywhere.
- Don't render user body text through `dangerouslySetInnerHTML`.
- Don't make the wiki edition-scoped — it's camp knowledge, like documents.
- Don't tie the Sierpinski page to a per-year `map_object` row as the primary
  link; the kind outlives every edition.

## Progress log

- [x] 2026-08-16 — duplicate-thread collision detected and diagnosed; plan
      written; peer skeleton reviewed (7 defects catalogued above).
- [x] Phase 1 — `db/schema/wiki.ts` rewritten (nullable author FKs, unique
      `(camp_id, slug)`, `campId` on revisions, new `wiki_link`); peer's
      unapplied `0070_mighty_hydra` removed and regenerated as
      **`0070_hard_johnny_blaze`** (3 CREATE TABLEs, no unrelated churn);
      `app/lib/wiki.ts` (subject registry, `[[…]]` link resolution, markdown-
      subset parser, excerpt/backlink helpers) + `wiki.server.ts`.
      20 parser unit tests in `app/lib/wiki.test.ts`.
- [x] Phase 2 — three routes rewritten clean (no `@tabler`, no `title=`):
      index (search, create, excerpts), view (rendered body, subject chips,
      backlinks, history + officer restore, officer delete via Mantine modal),
      edit (link picker, live preview, change summary). Red-links land on the
      page itself with "Create this page" rather than 404ing. Nav link added to
      `layout.tsx` beside Documents.
- [x] Phase 3 — map integration: `wikiTiesFor` resolves kind- and object-level
      ties in two queries and rides the existing map loader; the side panel
      shows the tied page, or "Start a wiki page for X" which hands off to
      `/wiki?subject=structure_kind:…` and comes back pre-linked.
- [x] Phase 4 — typecheck + lint + build green; 174/174 unit tests;
      migration verified on a VACUUM snapshot **and** applied to the local dev
      DB (69→71, 3 tables, 0 FK violations, camps/objects intact);
      **`e2e/wiki.ts` 17/17** on a scratch server (`bun run e2e:wiki`).

**E2E gotcha worth keeping:** seeded memberships need `wizardStep: 1`. With 0,
the dashboard layout loader redirects everything to `/start` — and because that
redirect happens *after* the action runs, a POST still takes effect while
returning 302, which reads like a failure that isn't one.

## Locked: the wiki is never public

Asked and answered (Cameron, 2026-08-16): **"CampTool is private first. No
publishing directly from CampTool."** So a wiki page is camp-internal, full
stop — there is no public wiki surface, and no "publish this page" affordance
is to be added later. As built: all three routes live inside the auth-required
dashboard layout and every loader/action runs `requireActiveCamp` +
`requireFeature`; an anonymous `/wiki` 302s to login on the live deploy.

If a camp wants something public, the answer is to put it somewhere that is
already deliberately public, not to expose a wiki page.

## Open questions for the user

1. Attachments/images — out of scope for now (no storage infra, same reason
   `camp_document` is links-only). Links to Drive work today.
