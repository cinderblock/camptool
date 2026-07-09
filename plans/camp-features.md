# Camp features — per-camp opt-in feature gating (off / preview / on)

> Task plan. Parent living plan: `plans/camptool.md` (read that first). Surface
> this path in responses while working on this.
> Plan path: `plans/camp-features.md`

## Goal (user ask, 2026-07-07)

Make the app's features **opt-in plugins per camp**. Each camp admin chooses
which features their camp uses, and can **explore a feature before opening it
up to the rest of the camp** (a preview period). A brand-new camp starts as a
roster + a small starter set; everything else is turned on deliberately.

**Naming.** This is NOT the Phase 2.5 camp-theme package seam (build-time code
plugins for self-hosters). This layer is **runtime, per-camp, data-driven
toggles** stored in the DB — call it **camp features** to keep the two distinct.

## Locked decisions (user Q&A, 2026-07-07)

1. **Preview scope = officers+.** A feature in `preview` is fully functional but
   visible only to admin + officers; members/recruits don't see its nav link and
   its routes bounce them. The leadership team explores together, then the admin
   flips it to `on`.
2. **Minimal core.** Core (always on, not toggleable): Overview `/`, guide,
   members directory, invite friends, years/editions, `/start` wizard shell,
   site admin. **Everything else is a feature** (list below).
3. **Defaults: starter set on for new camps; existing camps grandfathered.**
   New camps get a curated starter set pre-enabled (`announcements`,
   `documents`, `questions`); the rest start `off`. The migration seeds every
   EXISTING camp with ALL features `on` so nothing disappears (Math Camp is
   live and uses everything).
4. **Sequencing: this ships BEFORE the Schedule feature**
   (`plans/events-scheduling.md`). Schedule then ships as the first feature
   born inside the system — naturally starting in `preview`.

## Design

### Feature registry — `app/lib/features.ts` (pure, client-safe)

The catalog is CODE (like `structures.tsx` / the wizard ask catalog); the
per-camp STATE is data. One entry per feature:

```ts
type FeatureKey = "announcements" | "documents" | "questions" | "onboarding"
  | "map" | "bringing" | "supplies" | "tickets" | "passes"
  | "finances" | "dues" | "recruiting" | "roster" | "schedule" | "training";

type CampFeatureDef = {
  key: FeatureKey;
  label: string;          // "Camp map"
  description: string;    // shown on the settings page + preview banner
  starter?: boolean;      // pre-enabled for NEW camps
  requires?: FeatureKey[];// e.g. dues -> finances (settings UI enforces)
  navLinks: { to: string; label: string; minRole?: Role; end?: boolean }[];
  routes: string[];       // path prefixes gated by requireFeature
};
```

Feature → surface mapping (initial):

| key | routes | nav | starter | notes |
|---|---|---|---|---|
| announcements | /announcements | Announcements | ✓ | Overview's latest-3 card follows the flag |
| documents | /documents | Documents | ✓ | |
| questions | /questions | Questions | ✓ | wizard questionnaire ask follows |
| onboarding | /onboarding | Onboarding | | checklist; wizard checklist ask follows |
| map | /map | Map | | |
| bringing | /bringing, /inventory | Bringing (+ Inventory officer) | | declare-gear + officer accounting travel together |
| supplies | /supplies | Supplies | | |
| tickets | /tickets | Tickets | | wizard tickets ask follows |
| passes | /passes | Passes | | |
| finances | /finances | Finances (officer) | | |
| dues | /dues | Dues (officer) | | requires finances; replaces `camp.tracksDues` |
| recruiting | /recruits, /c/:slug | Recruits (officer) | | off = public apply page 404s |
| roster | /roster | Who's coming | | in-flight attendee thread — convert once landed |
| schedule | /schedule* | Schedule | | future (`plans/events-scheduling.md`) |
| training | /training | Training | | future; independent of schedule (if off, schedule's requirement gating is simply absent) |

Core (NOT in the registry, never gated): `/`, `/guide`, `/members`, `/invite`,
`/editions`, `/start`, `/admin`, auth/api/telemetry routes.

### State storage — `db/schema/feature.ts`

**`camp_feature`** — CAMP-scoped (not edition; features are how the camp runs,
not per-year). One row per (camp, feature) that has ever been explicitly set;
**absence = default** (`starter ? "on" : "off"` — no seeding hook needed for
new camps).

- `id, campId` (the invariant)
- `featureKey` text
- `state` text — `off | preview | on`
- `updatedByMembershipId`, `createdAt`, `updatedAt`
- unique `(campId, featureKey)`

Effective state = `row?.state ?? (def.starter ? "on" : "off")`.

### Resolution + gating — `app/lib/features.server.ts`

- `loadFeatureStates(campId)` → `Map<FeatureKey, State>` (defaults applied).
  One small query; called in the layout loader + `requireFeature`.
- `featureVisibleTo(state, role)`: `on` → everyone; `preview` →
  `hasAtLeast(role, "officer")`; `off` → nobody.
- `requireFeature(active, key)` — route-loader guard beside
  `requireActiveEdition`: resolves the caller's visibility; not visible →
  `throw redirect("/")` (same bounce pattern as camp-less users; hidden
  features shouldn't 404-vs-403 leak or dead-end).
- Public/unauthenticated surfaces (`/c/:slug`) resolve the camp from the slug
  and check `recruiting` directly (404 when off — there's no session to bounce).

### Nav + preview UX (`layout.tsx`)

- The layout loader returns `visibleFeatures: { key, preview }[]` for the
  active camp + role. The hardcoded nav list is rebuilt from CORE_NAV + the
  registry's `navLinks` filtered by feature visibility + `minRole` (this
  replaces today's inline `tracksDues` special case).
- A `preview` feature's nav link gets a small **"Preview" badge**, and its pages
  render a dismissable banner: "Only officers can see this feature — open it to
  the whole camp in Features." → deep-links the settings page. Officers must
  never mistake a preview for launched.

### Settings UI — `routes/dashboard/settings.tsx` (`/settings`, ADMIN-only)

The camp has no settings page today; this creates it (nav: "Camp settings",
admin only). One card per registry entry: label, description, status, and a
SegmentedControl **Off / Preview / On**. `requires` unmet → enabling prompts to
also enable the dependency. Turning a feature `off` **never deletes data** —
tables keep their rows; flipping back on restores everything. Copy says so.

### `tracksDues` fold-in

`camp.tracksDues` is the one existing per-camp gate — it becomes feature `dues`.
Migration: `tracksDues = true` → insert `camp_feature(dues, on)`; drop the
column (grep: `dues.tsx` redirect, `finances.tsx` toggle + loader,
`index.tsx` to-do, `layout.tsx` nav). The Switch on `/finances` moves to
`/settings` (finances page links there instead).

### Integrations that must respect flags (conversion checklist)

- **Season wizard** (`app/lib/wizard.ts` scheduler): asks map to features
  (bringing→bringing, tickets→tickets, questionnaire→questions,
  checklist→onboarding). `scheduleAsks` gains the camp's feature states and
  drops asks whose feature isn't visible to that member. RSVP/profile are core.
- **Overview home** (`index.tsx`): to-do cards + announcements card gated the
  same way.
- **Guide** (`/guide`): describes features — filter sections by enabled state.
- **`/start` wizard** stays core; its content already adapts via the ask list.

## Phases (each a coherent, shippable, green commit)

1. **Registry + schema + helpers.** `features.ts` catalog, `camp_feature` table
   + migration (grandfather DML: every existing camp × every feature → `on`;
   `tracksDues` → `dues`, drop column; verify on a VACUUM-INTO DB copy),
   `features.server.ts`. Nothing user-visible yet (defaults keep behavior
   identical).
2. **Gating + settings.** `requireFeature` in every gated route loader; nav
   rebuilt from the registry; preview badges + banner; `/settings` admin page.
   Browser-test the three states as admin / officer / member (impersonation).
3. **Integrations.** Wizard ask filtering, Overview cards, guide filtering,
   `/c/:slug` recruiting gate, finances/dues cleanup.
4. **Then** build Schedule (`plans/events-scheduling.md`) as a registry feature
   from day one (`schedule`, `training` keys are already reserved above).

Per phase: typecheck + build + biome green; migration verified on a DB copy;
update `plans/camptool.md`; stage ONLY this task's files (shared tree); push +
watch CI green.

## Findings / gotchas

- **Shared tree is HOT.** `plans/camptool.md` changed under this session
  mid-edit and `/roster` (attendee thread) appeared in the layout nav during
  this design. Expect `layout.tsx` merge friction — apply edits on top of
  what's there, never replace wholesale. Re-read before every edit.
- **Migration numbering:** journal said 0051 at design time; re-check at
  generate time. The uncommitted-schema-export gotcha applies again
  (`attendee`/`flag`/season churn) — toggle un-migrated exports off around
  `db:generate` so this migration contains ONLY `camp_feature` (+ the
  `tracks_dues` drop), then restore. Eyeball the SQL.
- **Dropping `tracks_dues`** may force a SQLite table rebuild of `camp` in the
  generated migration (like migration 0002's rebuild) — fine, but eyeball that
  the rebuild preserves all current `camp` columns, incl. any another thread
  just added.
- **`/c/:slug` gating changes public behavior** — an existing camp's apply page
  stays up via grandfathering, but document in README/self-host docs that
  recruiting must be enabled for the public page.

## Open questions for the user (recommendation in **bold**)

1. Starter set contents — **announcements + documents + questions** (as
   answered); flag if you want onboarding or roster in it too.
2. Should **officers** be able to change feature states, or strictly admin?
   **Strictly admin** (matches "each camp admin can opt in"); officers see the
   settings page read-only? — currently designed: page is admin-only, not
   visible to officers at all.

## Things not to do

- Don't conflate this with the camp-theme package seam (Phase 2.5) — that's
  build-time code; this is runtime per-camp data.
- Don't delete feature data when a feature is turned off.
- Don't seed rows for new camps (defaults come from the registry); DO seed
  grandfather rows for existing camps in the migration.
- Don't 404 logged-in users off hidden features into a dead end — bounce to `/`.
- Don't assume a single camp; `camp_feature` carries `camp_id`.

## Progress log

- [x] 2026-07-07 — design + user Q&A (4 forks locked); plan written.
- [ ] Phase 1 — registry + schema + migration (grandfather + tracksDues fold-in).
- [ ] Phase 2 — gating + nav + preview UX + /settings.
- [ ] Phase 3 — wizard/Overview/guide/public-page integrations.
- [ ] Phase 4 — Schedule built as a feature (see plans/events-scheduling.md).
