# Privacy mode & demo mode — pseudonymize PII for screen-sharing and demos

> Task plan. Parent living plan: `plans/camptool.md` (read that first). Surface
> this path in responses while working on this.
> Plan path: `plans/privacy-and-demo-mode.md`

## Goal (user ask, 2026-08-03)

Two related capabilities:

1. **Privacy mode** — a sticky per-browser toggle that hides/obfuscates PII, so
   the live instance can be demoed to other people (other camps, prospective
   members, conference talks) **without building a fake dataset**. The real
   schedule, real counts, real structure stay visible; the humans don't.
2. **Demo mode** — a throwaway sandbox where a viewer can click around and
   *make changes*, then reset everything back to a pristine state.

## Status: privacy mode is BUILT (2026-08-03). Demo mode is not started.

## Locked decisions (user Q&A, 2026-08-03)

1. **Deterministic pseudonyms, not redaction.** Real-looking fake names/emails,
   stable per person, consistent across every page and every table. `████` and
   blur make the members table, roster, and map — the most demo-worthy screens —
   unreadable, and pseudonyms are exactly the "fake dataset from the real one's
   shape" the user asked for.
2. **Privacy toggle ships first**, before the demo DB.
3. **Server-side only, cookie-backed.** The flag lives in an HttpOnly cookie
   read in the loader; PII is replaced *before* it leaves the server. See
   "Why not localStorage" below — this one is not really a choice.
4. **Privacy mode is a screen-share convenience, NEVER an access control.**
   It must not become "give the volunteer a privacy-mode login" — that's RBAC
   and a different feature. Say so in the code comment and the UI copy.
5. **Privacy mode is read-only** (see "Write footgun"). Demo mode is where
   writes are allowed, because it has a reset.
6. **Admin-only** (user, 2026-08-03). Officers and below never see the toggle,
   and the mode is re-derived from the role on every request, so a demoted
   admin's stale cookie stops applying immediately.
7. **"Keep my own name" is an option** (user, 2026-08-03), not the default. The
   header menu offers off / on / on-but-keep-my-name.

## Environment / context

- React Router v7.13, framework mode, SSR. `react-router.config.ts` has only
  `ssr: true` — **no future/middleware flags enabled**. Route `middleware` is
  available in this version but currently unused; turning it on is optional.
- Custom production server entry: `server.ts` (Bun, unix socket, behind Caddy).
- `DATABASE_PATH` env var already fully parameterizes the SQLite file
  (`db/client.server.ts:9`, default `./data/camptool.db`, `/data/camptool.db`
  in `compose.yaml:23`). Migrations auto-apply on boot.
- Live real PII on disk at `data/camptool.db`. Any demo/seed work must target a
  **separate** `DATABASE_PATH`.

## Findings from the codebase survey (2026-08-03)

These drove the design; don't re-derive them.

### There is no shared display layer for PII

- **~189 direct PII field accesses across 36 files.** Hot spots:
  `dashboard/map.tsx` (17), `start.tsx` (12), `dashboard/tickets.tsx` (9),
  `dashboard/members.tsx` (9), `c.$slug.tsx` (9), `dashboard/passes.tsx` (8).
- The `guestName ?? memberName ?? fallback` rule is **re-implemented inline in
  7 places**: `app/lib/programming.server.ts:72`, `app/routes/start.tsx:184`,
  `dashboard/tickets.tsx:110`, `passes.tsx:112`,
  `programming.$offeringId.tsx:93`, `finances.tsx:457`, `map.tsx:9042`.
- The "First «Playa» Last" formatter exists **once**, inlined at
  `dashboard/map.tsx:3212`.
- Only shared name helper: `presenterName()` at `app/lib/programming.ts:149`.
- **No Avatar component** anywhere (`user.image` is stored, never rendered).
- **No React context providers at all** (`createContext` → 0 hits in `app/`).
- Only shared PII *input* component: `app/components/PlayaNameField.tsx`.

**Consequence:** there is no single component to wrap. Redaction has to happen
in the data, not the view.

### Loaders DO share an entry point

28 of 37 loaders funnel through `resolveActiveCamp` / `requireActiveCamp` /
`requireActiveEdition` (`app/lib/session.server.ts:214/245/255`). That is the
natural place to *resolve the flag*.

The 9 loaders that don't, and must be handled individually:

| Route | Why it matters |
|---|---|
| `routes/dashboard/admin.tsx` | Super-admin table of names + emails (`:418-420`) |
| `routes/c.$slug.tsx` | Public camp page |
| `routes/c.$slug.schedule.tsx` | Public lineup, renders `presenterName(p)` (`:150`) |
| `routes/export-db.tsx` | Raw `sqlite.serialize()` of **every camp** — no transform possible |
| `routes/i.$token.tsx` | Invite landing |
| `routes/api.dev.errors.tsx` / `api.dev.feedback.tsx` | Return `userName`, `userAgent`, `url`, `metadata` (`:56`) |
| `routes/login.tsx`, `routes/api.auth.$.tsx` | Auth surface |

### Why not localStorage

There is **zero `localStorage` / `sessionStorage` / `document.cookie` usage in
`app/`** today. All persistence is server cookies, hand-rolled, with a shared
shape (`Path=/; HttpOnly; SameSite=Lax` + `Secure` when `PUBLIC_BASE_URL` is
https). The closest precedent is `camptool_edition` —
`setEditionCookie()` at `session.server.ts:89`, consumed in `resolveActiveCamp`
at `:226`.

A localStorage-backed toggle would render the **real** names server-side and
hide them on hydration. A privacy feature that flashes the PII it is hiding is
worse than no feature. `app/root.tsx:36-44` (`earlyColorSchemeCss`) documents
this exact SSR-flash trap for the color scheme; read that comment before
touching root.

### Where PII leaves the app

- **No email sending exists at all** (zero SMTP/resend/nodemailer hits). Invites
  are link-only via `/i/:token`. One less surface.
- **Discord**: `app/lib/discord.server.ts`, REST only. `checkGuildMembership()`
  sends a Discord user ID outbound. No DM sending implemented.
- **Day sheets**: `routes/dashboard/programming.board.tsx`, loader
  `loadDaySheet()` at `app/lib/programming.server.ts:214`, `window.print()`,
  `@media print` at `:220`. Client-rendered from loader data → **inherits
  redaction for free**.
- **BM map JPEG export**: `dashboard/map.tsx:3175` `BurningManExport` renders
  contact name + playa name + email + phone to canvas. Also client-side from
  loader data → inherits redaction, but the *source* is `camp.placementContact*`
  which must be in the field registry.
- **`/export-db`** — raw SQLite bytes. Cannot be pseudonymized in flight.
  **Hard-block it when privacy mode is on.**
- **No CSV export anywhere.**

### PII columns by table (from `db/schema/`)

Direct identity: `user.name/email/image`; `session.ipAddress/userAgent`;
`account.*Token/password`; `passkey.name`; `verification.identifier`;
`membership.playaName`; `invitation.email`; `discord_link.discordUserId/
discordUsername`; `attendee.name/email/note`; `recruit_application.name/email/
playaName/previousCamp/previousCampNotes/message/answers/reviewNotes`;
`camp.placementContactName/Playa/Email/Phone`.

Free-text / PII-adjacent: `question_answer.value` (**the biggest open-ended
sink** — camps define arbitrary prompts as data, so dietary/medical/emergency
contact can all land here and the schema cannot bound it); `map_object.name/
notes/ownerMembershipId`; `placement.address/street/notes`; `ticket.notes`,
`ticket_request.note`, `setup_pass.note`, `ticket.priceCents/tier` (low-income
tier is income-adjacent); `contribution.counterparty/description`,
`dues_assignment.notes`; `training_signoff.note`; `gathering_occurrence.note`;
`offering.description/reviewNote`, `offering_presenter.name` (outside speakers,
no account), `offering_session.note`; `inventory_item.name/notes`;
`announcement.body`; `flag.body`; telemetry `client_error.message/stack/url/
userAgent/breadcrumbs/userId` and `feedback.title/body/details/metadata`.

**Not present as columns:** vehicle plates, street addresses, emergency
contacts, dietary/medical, ticket numbers. Those can only exist inside
`question_answer.value`.

## Design

### The pseudonymizer — `app/lib/privacy.ts` (pure) + `privacy.server.ts`

```
pseudonym(kind, realValue) -> string
```

- Seed = `HMAC-SHA256(BETTER_AUTH_SECRET, kind + ":" + realValue)`, taken as an
  index into per-kind word lists.
- **Seed on the VALUE, not the row id.** This is the key trick: the same real
  person gets the same pseudonym no matter which table or join they surfaced
  through — `user.name`, `attendee.name`, `offering_presenter.name`, and a name
  typed into `map_object.name` all collapse to one consistent fake identity,
  with no cross-table wiring.
- Per-install secret means the mapping is stable across restarts but not
  reversible by a viewer who knows the algorithm.
- Kinds: `person`, `playa`, `email`, `handle`, `phone`, `freeText`, `drop`.
- **Shape preservation:** null/empty stays null/empty; roughly preserve length
  and word count so layouts demo honestly; vary email domains.

### Applying it — `redact(request, data, opts?)` at loader return

37 loaders, one line each: `return redact(request, { ... })`. A deep transform
over the returned object, driven by a **field registry** of key names → kind.

**The known hazard — key-name collisions.** A blanket "any key called `name`"
rule over-redacts things that are NOT PII and would make the demo *worse*:
`camp.name`, `offering.name` (a talk title), `inventory_item.name`,
`map_object.name` (often "Big Shade Structure"), `document.name`,
`question.prompt`. Resolution:

- Registry is conservative by default: `email`, `playaName`, `discordUsername`,
  `discordUserId`, `phone`, `ipAddress`, `image` are always PII.
- `name` and free-text keys are redacted **only when the call site opts in**:
  `redact(request, data, { people: ["members", "attendees", "presenters"] })`
  naming the arrays/objects that hold humans.
- Everything else passes through untouched.

This is the main design risk. It is deliberately biased toward *under*-redacting
by accident being caught by the test below, rather than over-redacting silently
and producing a confusing demo.

### Enforcement — the crawl test (this is what makes it maintainable)

A test that:

1. Boots against a scratch DB seeded with recognizable PII.
2. Reads `app/routes.ts` so **new routes are covered automatically**.
3. Logs in, GETs every route with `camptool_privacy=1`.
4. Asserts no real PII string from the DB appears in **any** response body —
   the SSR HTML *and* the `.data` turbo-stream payload for client navigations.

Without this, a forgotten `redact()` in a route added six months from now
silently leaks, and the whole feature's trustworthiness is gone. This is the
deliverable that matters most; the transform itself is the easy part.

### The toggle & the indicator

- Cookie `camptool_privacy`, same shape as `camptool_edition`. Unsigned — it
  grants no authority and defaults to off, so there is nothing to forge.
- Set from a small action (mirroring `dashboard/editions.tsx:93,149`); resolved
  in `resolveActiveCamp` and exposed on `ActiveCampContext`.
- **Mandatory loud indicator.** A mode that looks real is a mode you forget you
  are in, then act on — emailing a person who does not exist, or making a call
  from fake numbers. Needs a persistent banner *and* an accent shift across the
  whole chrome, not a small badge. Copy: names on this screen are fake.

### The write footgun → privacy mode is read-only

If a form pre-fills from pseudonymized loader data and you save it, the
**pseudonym gets written into the real database**. That is silent, permanent
corruption of exactly the data the feature exists to protect.

Cheapest complete fix: block mutating actions server-side while privacy mode is
on, with a clear message. One check, and the entire class of bug disappears.
Reading is all a demo needs; writes are what demo mode (separate DB, resettable)
is for. Revisit only if read-only proves too limiting in practice.

## Plan / steps

- [x] **1. `app/lib/privacy.ts`** — cookie shape + field classification rules.
      Pure, no crypto, no DB.
- [x] **2. `app/lib/privacy.server.ts`** — pseudonyms, lens, `redact()`, the
      dev leak audit. No DB import either (session.server does the queries), so
      it is unit-testable without opening SQLite or running migrations.
- [x] **3. Cookie + context** — `setPrivacyCookie()`, read in
      `resolveActiveCamp`; `privacy` / `privacyMode` / `canUsePrivacy` on
      `ActiveCampContext`.
- [x] **4. Coverage guard** — `app/lib/privacy-coverage.test.ts` reads
      `app/routes.ts` and fails any route with a loader that neither redacts nor
      carries a written exemption. Also checks for stale exemptions and for
      route files on disk missing from `routes.ts`.
- [x] **5. Wrap loaders** — all 37, plus `/export-db` hard-blocked (409).
- [x] **6. Read-only guard** — `assertWritable()`, applied centrally in
      `resolveActiveCamp` for any non-GET/HEAD request. Opt out with
      `{ allowWrite: true }` (used by `/privacy` and the year switcher).
- [x] **7. Toggle UI + banner + chrome accent** — header menu (admin-only),
      orange header background and a dismissible banner while on.
- [x] **8. Unit tests** — 24 across pseudonymizer, classification, redaction,
      keepSelf, and coverage.
- [ ] **9. Manual false-positive pass** — walk every screen with the toggle on
      and confirm nothing non-PII got mangled. NOT YET DONE; see "Verified so
      far" below for what has been checked.
- [x] **10. README / docs note** — self-hosters get this too; document that it
      is not an access control.

## Verified so far (2026-08-03)

- `bun run typecheck`, `bun test` (24 pass), `bunx biome check app/`, and
  `bun run build` all green.
- Exercised against the **real** `data/camptool.db` (read-only) with a
  members-page-shaped payload built from real rows: 4 members + 3 attendees,
  13 vocabulary tokens. Result: names/emails pseudonymized, `campName`
  ("Math Camp") and `structures[].name` ("Big Shade Structure") left intact —
  the personhood heuristic works on real data — the real name inside a
  free-text note swapped to **the same pseudonym** as that person's roster row,
  and **0 real tokens surviving anywhere in the output**.
- NOT yet exercised through a running browser session. The manual sweep (step 9)
  is what would catch over-redaction on screens whose payload shapes weren't
  sampled, and `playaName` is null for every real member today so the playa path
  is only covered by unit tests.

## Known rough edges

- **Forms stay clickable in privacy mode.** They fail loudly with a 403 from
  `assertWritable` rather than being visually disabled. Acceptable (the banner
  says editing is off) but it lands the user on an error boundary; disabling the
  controls would mean touching every form in the app.
- **Public routes are not redacted** — `/c/:slug`, `/c/:slug/schedule`,
  `/i/:token`. They have no session to carry the cookie, and show only what the
  camp deliberately published. Listed as exemptions in the coverage test.
- **Site admin spans camps** but the lens vocabulary is camp-scoped, so free
  text there may mention people from other camps without substitution. Keyed
  fields (names, emails) still redact.
- **Under impersonation**, "keep my own name" keeps the impersonated target's
  name, not the real admin's — the lens is seeded from the effective session.

Then, separately: **demo mode** — `DATABASE_PATH=./data/demo.db`, pristine
snapshot generated by running the same pseudonymizer over a *copy* of the real
DB (offline script, not per-request), reset = file copy. Writes allowed there.
`/export-db` already proves the serialize path works.

## Things not to do

- Do **not** use localStorage for the toggle — it flashes real PII before
  hydration. See "Why not localStorage".
- Do **not** let privacy mode be treated as an access control or a permission
  tier. If that need appears, build RBAC.
- Do **not** blanket-redact every key named `name` — it destroys talk titles,
  structure names, and the camp name.
- Do **not** run the anonymizer against `data/camptool.db` in place. Copy first.
- Do **not** allow `/export-db` while privacy mode is on; the bytes cannot be
  transformed in flight.

## Open questions for the user

1. Should **your own** name in the header be pseudonymized too? Recommend yes,
   for consistency — the banner tells you where you are, and an un-redacted name
   in the chrome is exactly what a screen-share leaks first.
2. Read-only in privacy mode: locked as the default above. Flag if that blocks
   a demo you actually want to give.

## Progress log

- **2026-08-03** — Codebase surveyed (PII columns, 189 render sites, cookie vs
  localStorage precedent, loader funnel, export surfaces). Design decided:
  deterministic value-seeded pseudonyms, server-side, cookie-backed, enforced by
  a route-crawl test.
- **2026-08-03** — Privacy mode implemented end to end. Two findings that
  changed the design mid-build:
  1. **Per-word seeding.** Seeding a pseudonym on the whole value meant a note
     mentioning "Sarah" got a different fake first name than the roster row
     "Sarah Chen". Names are now seeded per word, so partial mentions agree with
     full ones — and two real Sarahs share a fake first name, as in life.
  2. **The write-back footgun is real, not theoretical.** `BurningManExport` in
     `map.tsx` submits its pre-filled contact fields back via
     `setPlacementContact`; in privacy mode that would have persisted the
     pseudonym over the camp's real placement contact. This is what the
     read-only guard exists to stop, and it justified putting the check
     centrally in `resolveActiveCamp` rather than per-action.
- **2026-08-03** — Coverage guard chosen over the full HTTP crawl test
  described earlier in this plan. The crawl would need a booted server plus a
  synthesized better-auth session; the static guard catches the actual
  maintenance risk (a new route forgetting to wrap) for a fraction of the
  effort, and the dev-mode leak audit inside `redact()` covers the "registry
  missed a field" case at runtime while clicking around. Revisit if the audit
  proves too noisy or too quiet.
