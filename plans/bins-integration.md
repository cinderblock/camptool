# bins integration — from a menu item to linked data

> Task plan. Parent living plan: `plans/camptool.md` (read that first).
> Plan path: `plans/bins-integration.md`

## Goal

CampTool and **bins** are sibling apps run by the same camp. bins
(`../bins`, live for Math Camp at `i.mathcamp.us`) is an offline-first PWA
inventory tracker: a QR sticker on every box, scan it to see what's inside.
CampTool should reach it.

Cameron's scoping (2026-08-16), in order:

1. **Ship first:** "just an optional menu item that, on click, opens the bins
   interface logged in" — **in the top bar**. ✅ done, see Phase 1.
2. **Then, carefully:** the data link ("we also talked about linking the
   databases") and a possible **left-menu entry**. Not built yet — Phase 2.

## Environment / context

- bins repo: `C:\Users\camer\git\Personal Projects\bins` (sibling checkout).
  Bun · React Router v7 **SPA mode** · Dexie · Drizzle/SQLite · Mantine 8.
- bins is multi-group (`group_id` on every tenant table) and self-hostable, so
  a bins address is **per camp**, never a deployment-wide constant.
- **No shared code, ever.** bins' own `CLAUDE.md`: "Fully self-contained —
  never import code from other repos." The coupling is HTTP only.

## How bins authentication actually works (load-bearing)

bins has **no accounts**. Two ways in:

- **Scan a sticker** — `https://host/123#7HX6`, the fragment being that bin's
  secret. Scanning proves physical access.
- **The group access code** at `/join`. An invite link is just that code in the
  URL fragment: `` `${origin}/join#${encodeURIComponent(code)}` ``
  (`bins/app/lib/invite.ts`). The fragment is never sent to bins' server, the
  same log-hygiene reason sticker secrets live there.

So "opens bins logged in" = send the member to `/join#<accessCode>`. There is
no token to mint and no per-user identity to map — bins asks for a display name
and that's the whole session.

## Phase 1 — the top-bar hand-off (LANDED)

**Feature key `bins`** in the registry, default off, like everything else.

**`camp_bins`** (migration **0071**, one row per camp): `baseUrl`,
`accessCode`, optional `label`. Camp-scoped because each camp points at its own
bins instance.

**The access code is a secret, and the menu item renders on every page.** So
the href is **`/bins`**, a CampTool resource route that redirects to
`${baseUrl}/join#${code}` at click time (`app/routes/bins.tsx`). Putting the
join URL directly in the menu's href would have shipped the camp's shared
secret in the HTML of every page to every session — `e2e/bins.ts` #5 is the
test that tells those two implementations apart. The layout loader is handed
only `{ label }`, never the code.

**Who gets it:** members and up. A recruit is an applicant the camp hasn't
taken on yet; handing them the warehouse access code is a different call from
letting them read camp pages.

Opens in a new tab (`target="_blank"`, `rel="noopener noreferrer"`) — it's a
separate app, not a page of CampTool.

**Configured** at `/settings` (admin-only) in a card under the Bins feature,
shown once the feature isn't off. A blank access-code field means "keep the
stored one" — the form can't display the existing secret, so blank must not
silently erase it.

## Phase 2 — the data link (FIRST SLICE LANDED)

**What shipped:** a read-only **"In storage"** panel on `/supplies` — a search
box over the camp's real bins stock, so nobody buys a second roll of gaff tape
when there are four in the warehouse. Each hit links to that box in bins.

- **Auth:** bins mints scoped, revocable **integration tokens**
  (`POST /api/admin/integrations/create` → `bins_<prefix>_<secret>`, `scope:
  "read"`, shown once, hash stored). The admin pastes one into `/settings`; it
  lands in `camp_bins.api_token` (**migration 0078**) and is used **server-side
  only**. Distinct from `access_code` on purpose: that is a human credential
  handed to members, this is a machine one that can be revoked in bins without
  disturbing anyone's sign-in.
- **Caching:** 60s TTL, keyed by **camp + address + token**, so changing either
  takes effect at once rather than after the TTL. 4s timeout per request.
- **Degradation is the point.** No token, bins down, 401, garbage JSON, or slow
  → the panel is simply absent and Supplies renders exactly as before. A
  warehouse we can't reach must never stop anyone claiming a supply. One
  deliberate exception: a *transient* failure falls back to the last good
  snapshot, because stale beats empty for a blip.
- **Search runs client-side** over the snapshot in the loader payload, so
  typing is instant and doesn't hit bins per keystroke. That does mean bin
  names/locations reach the browser — they're camp data shown to members, which
  is the same bar as the rest of the page. The **token never does**;
  `e2e/bins-stock.ts` asserts it.

**Still open — per-supply matching.** The original July 30 wording was "show
real counts inline at the point of claiming", i.e. each supply line knowing its
own stock. That needs a way to match a supply row to bins boxes, and it is
still the unanswered design question below. The search panel delivers the
useful half without guessing at it.

### Original design notes (kept for context)

**This was already decided and then blocked.** `plans/july-30-meeting.md`
decision 4: *"Warehouse inventory → PULL bins data into the supplies view.
Fetch from the bins tracker and show real counts inline at the point of
claiming, rather than linking out or re-modelling stock. **Open dependency:
does the bins tracker expose an API?** … This couples the two apps at runtime,
which supersedes the earlier 'no code sharing' stance for *data* (still no
shared code)."* `plans/aug-6-meeting.md` still lists it as blocked on that
question.

**The blocker is resolved.** bins now ships `/api/v1` (`bins/api/v1.ts`),
whose docstring reads: *"the public, versioned read/embed surface for external
apps we control."*

- `GET /api/v1/bins` — all bins; filter `?location=` / `?status=`.
- `GET /api/v1/bins/{id}` — one bin plus its entries (photos, notes, authors).
- `GET /api/v1/locations` — the location list.
- Bearer token, **group-scoped by the token**; read-only access is enough.
- Photos: values expose sha256 hashes; fetch `/api/blobs/{hash}` with the same
  token.
- The sticker `secretCode` is deliberately never exposed.

**Design sketch (settle before building):**

- Store an API token on `camp_bins` (a nullable column beside `accessCode`).
- A server-side fetch with a short cache — never call bins from the browser,
  which would leak the token.
- Matching a CampTool supply line to bins stock is the real design problem:
  bins has free-text names, labels and locations; supplies have their own
  names. Options: a per-supply `binsQuery` string an officer sets; a label
  convention; or a `wiki_link`-style join table. **Don't guess — pick this
  with Cameron.**
- Degrade quietly: bins unreachable, token wrong, or feature off ⇒ the
  Supplies page renders exactly as it does today. A warehouse that can't be
  reached must never break claiming.

**Possible left-menu entry** (Cameron, "possible left menu entry"): a proper
`/bins` page inside CampTool showing stock, rather than only the top-bar
hop-out. Only worth it once there's data to show — i.e. after the pull above.

## Things not to do

- Don't import anything from the bins repo. HTTP only.
- Don't put the access code or an API token in any loader payload, or in any
  href rendered into a page.
- Don't hardcode `i.mathcamp.us` — it's per-camp config, and Math Camp is one
  camp among many.
- Don't re-model bins' stock in CampTool's tables; read it live.

## Progress log

- [x] 2026-08-16 — Phase 1: feature key, `camp_bins` + migration 0071,
      `/bins` redirect route, top-bar item, admin config card at `/settings`.
      typecheck + lint + build green, 174/174 unit tests, **`e2e/bins.ts`
      12/12** (`bun run e2e:bins`), migration verified (72 clean, 60 tables).
- [x] 2026-08-17 — Phase 2 first slice: `camp_bins.api_token` (**migration
      0078**, one ALTER), `app/lib/bins.ts` (pure search/title/href, 7 unit
      tests) + `bins-api.server.ts` (fetch, TTL cache keyed by credentials,
      graceful degradation), read-token field at `/settings`, and the
      **"In storage"** search panel on `/supplies`. typecheck + lint + build
      green, 307 unit tests, 79 migrations clean, **`e2e/bins-stock.ts` 10/10**
      against a stub bins instance (`bun run e2e:bins-stock`). Dev-server log
      checked for SSR throws — clean.
- [ ] Phase 2b — per-supply stock ("counts inline at the point of claiming"),
      blocked on the matching question below.
- [ ] Phase 3 — possible in-app bins page / left-menu entry.

## Open questions for the user

1. **How should a supply line find its bins stock?** My recommendation: an
   optional per-supply "bins search" string an officer fills in, matched
   against bins names/labels/notes — no convention to enforce, and it degrades
   to "no match, show nothing".
2. Should the top-bar item be **officers-only** instead of members+? Currently
   members+, since bins itself treats anyone with the code as a full user.
