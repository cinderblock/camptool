# Mobile support pass — make every page work well on phones

> Plan path: `plans/mobile-support.md`. Sibling to `plans/camptool.md` (the master plan).

## Goal

Revisit every page/route and make sure it works well on mobile (≈360–414px wide
phones, portrait). The app shell (`app/routes/dashboard/layout.tsx`) is already
responsive — AppShell with a burger-collapsed navbar at the `sm` breakpoint. The
work is inside individual pages: overflowing tables, fixed pixel widths wider than
a phone, button/stat rows that don't wrap, multi-column grids without responsive
`cols`, the SVG map editor, and modals/forms.

## Environment / context

- Stack: React Router v7 (SSR) · React 19 · Mantine · TS strict · Bun.
- Mantine responsive tools to prefer:
  - `Table.ScrollContainer minWidth={...}` to wrap wide tables (horizontal scroll).
  - `visibleFrom` / `hiddenFrom` props to swap layouts per breakpoint.
  - `SimpleGrid cols={{ base: 1, sm: 2, ... }}` responsive object syntax.
  - `Group` `wrap="wrap"` (default) — but watch for `wrap="nowrap"` + fixed widths.
  - `useMediaQuery` from `@mantine/hooks` only when a JS branch is unavoidable.
  - Prefer responsive props/objects over `useMediaQuery` (SSR-safe, no flash).
- Verify with: `bun run typecheck`, `bun run build`, `bun run lint`. Browser-test
  key pages at a 390px viewport if a dev server is available.

## Decisions already made (don't re-ask)

- "Best way, not fastest" — fix properly, keep code idiomatic to each file.
- Shared working tree: stage only our own changes; never discard others' edits.

## Plan / steps

1. [in progress] Audit every route + shared component for mobile issues (parallel
   agents). Catalog below with file:line + recommended fix.
2. [ ] Triage findings into a fix list, ordered by severity.
3. [ ] Apply fixes file by file.
4. [ ] typecheck + build + lint green.
5. [ ] Browser-verify the worst offenders at 390px.
6. [ ] Commit.

## Findings / gotchas

- **Mantine `Group` defaults to `wrap="wrap"`.** So a `Group` *without* an explicit
  `wrap` prop already reflows on mobile — not a problem. The real overflow risks are
  only the *explicit* `wrap="nowrap"` groups (and even most of those are fine when the
  flexible side has `minWidth: 0` and the other side is a small icon/button).
- **`Table.ScrollContainer minWidth={N}` is the CORRECT mobile pattern**, not a bug.
  Several audit passes flagged "minWidth=620 > 390px → scrolls" as critical — it's
  intended: dense tables scroll horizontally on phones. Every `<Table>` in the app is
  already wrapped in a `Table.ScrollContainer`. Left them alone.
- **Action-button groups inside `Table.Td` cells** (recruits/invite) use `nowrap` on
  purpose — the table already scrolls. Left them.
- The app shell (`dashboard/layout.tsx`) was already responsive (burger navbar at `sm`).

## Fixes applied

- **map.tsx (the big one).** The editor was a fixed-height (`calc(100vh-88px)`) two-pane
  layout: flex map + rigid `flex: 0 0 320px` side rail with `wrap="nowrap"` — on a phone
  the rail ate the screen and left ~70px for the map. Now: added `useMediaQuery` →
  `isNarrow` (`max-width: 768px`); outer `Group`→`Flex direction={{ base:"column", md:"row" }}`
  so the rail stacks BELOW the map on phones; rail `w={{ base:"100%", md:320 }}` and, when
  narrow, natural height + page scroll (not inner-scroll); map pane height `70vh` on mobile;
  container height `auto`/`minHeight: 100vh-88px` on mobile. Toolbar `Group` un-`nowrap`ped
  so buttons wrap. SVG already had `touch-action: none` (touch drag works).
- **start.tsx / bringing.tsx** — the per-gear "name + size inputs" rows were
  `wrap="nowrap"` with fixed-width inputs → overflow. Changed the outer + input groups to
  `wrap="wrap"` (kept the small swatch+label group `nowrap`).
- **supplies.tsx** — manage-mode `ItemRow` (qty + name + notes + owner + delete) was
  `wrap="nowrap"` → `wrap="wrap"`.
- **tickets.tsx** — allocation stat row (`Group gap="lg"`) → `SimpleGrid cols={{base:3,xs:3}}`;
  "Request a ticket" input `w={320}` → `w={{ base:"100%", xs:320 }}`.
- **members.tsx** — "Add a recruit by email" input `w={320}` → `w={{ base:"100%", xs:320 }}`.
- **finances.tsx** — "Track member dues" checkbox + anchor row `nowrap` → `wrap`.
- **recruits.tsx** — public-link card `nowrap` → `wrap`, left div `minWidth:0`, anchor
  `wordBreak: break-all` so the long URL wraps.
- **passes.tsx** — officer date-row (date/badges + grant Select) `nowrap` → `wrap`,
  left div `minWidth:0`.

## Verified

- `bun run typecheck`, `bun run build`, `bunx biome check app/<edited files>` all green.
  (Repo-wide `bun run lint` reports pre-existing errors only in `db/migrations/meta/*.json`
  and `app/entry.server.tsx` — not touched by this work.)
- Browser-checked at true 390px: `/login` and the public `/c/:slug` recruit page render
  cleanly, no horizontal overflow.
- **NOT browser-verified: the authenticated dashboard pages** (map editor, tickets, etc.).
  `/` redirects to `/login` with no session and I can't enter credentials. Needs the user
  to sign in for a visual pass. Code review + typecheck + build cover correctness.

## Progress log

- [x] Audit (4 parallel agents over all routes + components)
- [x] Fixes (9 files)
- [x] Verify (typecheck/build/lint green; public pages browser-checked at 390px)
- [ ] Browser-verify authed pages at 390px (blocked on login — offer to user)
- [ ] Commit
