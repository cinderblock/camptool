# CampTool

Self-hosted registration & management for event **theme camps**: member
management, a visual camp-map editor tied to the database, optional dues, camp
onboarding, shared documents, announcements, a public recruit page, and
Discord-based outreach. Built for one camp first; designed to be publishable for
other camps to self-host.

The core app is **event-agnostic**. Burning Man — its Black Rock City
map/addressing and ticket/pass flows — is one *event layer* on top, bundled in
this repo for now but designed to peel out; a single camp can attend multiple
events (see the four-layer architecture in the plan).

> Full vision, decisions, schema, and roadmap live in
> [`plans/camptool.md`](plans/camptool.md). Read it first.

## Stack

- **Runtime:** Bun
- **Framework:** React Router v7 (framework mode, SSR) + React 19
- **UI:** Mantine
- **Database:** SQLite via `bun:sqlite` + Drizzle ORM
- **Auth:** better-auth (Discord, email/password, passkeys; magic link is wired
  but hidden — see "No mail transport" below)
- **Format/lint:** Biome

## Status

Phase 3 — camp map editor (in progress). On top of the Phase 1 foundation
(multi-camp data model; auth via email/password, magic link, passkeys, optional
Discord; member directory with role management, officer-gated removal, and
private member-to-officer issue flags) and Phase 2 recruiting (public
`/c/:slug` application page, officer review queue, per-member onboarding
checklists), the dashboard now has a **Map** tab: a visual, database-backed
editor for laying out camp. The map/addressing is a pluggable **per-event
provider** (Black Rock City is the built-in one). Set your lot (street, address,
frontage × depth, and an optional Man→street radius that draws the real wedge
taper), then add
structures from a palette (tent, RV, shade, kitchen, art, generator, container)
and drag/resize/rotate them into place, with an orientation compass (true north,
sun, the Man) and footprint shapes for tents, hexayurts, hyparhuts, cars/RVs.

It's also **inventory-driven**: campers declare what they're *bringing* on a
**Bringing** page (each item sized, unplaced); officers drag those items from an
**Unplaced** tray onto the lot to place them and add shared camp items; an
**Inventory** view accounts for everything (owner, size, placed-or-not).

There's **scratch space** around the lot for the things you haven't sited yet.
Drop something outside the border and it parks there at true scale, so a 30-foot
trailer looks like thirty feet next to your hundred-foot frontage instead of a
line in a list. Nothing ever ends up half in: drag across the border and the
whole footprint snaps to one side or the other. Staged items stay on the Unplaced
queue — parking one is a look, not a decision.

Campers can also say what they want to be **near** — their own vehicle, or a
particular person — and the map draws a faint line between the two so whoever is
arranging it can see the wishes while arranging. They're wishes, not rules;
nothing stops you placing people apart.

The map plans camp networking too — its own **Network** palette group. A **Wi-Fi
access point** draws its usable coverage as a ring, so overlapping APs and dead
spots are visible while you place them.

For Burning Man specifically, BMorg's public internet comes off sector
antennas on the NOC tower in Center Camp, which a camp radio needs line of sight
to: drop an **Uplink radio** on the corner of an RV, container or shade frame,
set its antenna height, and the map draws the aim path to the NOC and flags
anything of yours tall enough to block it — so "which corner does the dish go
on" is answered before you're on playa.

The map carries a few more touches: recognizable top-down icons per kind, an
owner's first name on each domicile, a highlight filter (mine / domiciles /
vehicles / structures), a grid scale-and-skew caption in real feet-and-inches,
and **free-polygon zones** (fire lane, public/private areas). Editing is
ownership-aware: officers arrange the lot, while a camper can move/resize their
own item — those changes apply live but stay **pending** until an officer
approves or rejects them.

New campers get a guided, resumable **onboarding wizard** at `/start`: a
full-screen walkthrough to set a playa name, declare what they're bringing, add
who's sharing their tent/RV, and tick the camp's checklist — one step at a time.
It is only ever a *view*: every step it collects has a permanent home elsewhere
(**Your trip** for the RSVP, stay dates and any note; **Bringing** for gear and
who's sleeping in it; **Questions**, **Onboarding**, **Your account**), and the
wizard posts into those pages' own actions. So the derived "Your to-do" list
always links you to the setting, never back into the tour. Next: RV pop-outs and
group sub-maps.

The dashboard also tracks the camp's per-year ticket allocations (a Burning
Man–event feature today). A **Tickets** page manages the camp's Direct Group Sale
(guaranteed) allocation — individual
priced tickets (tier + price, any mix of free/cheap/expensive) that officers
assign to members and mark paid; members can request one. A **Passes** page
handles early-arrival **Setup Access Passes**: officers define "on or after"
dates with a per-date quota (e.g. 2 valid from Monday, 4 from Wednesday), and
an officer grants each request a date that covers the requester's planned
arrival, quota-enforced.

Asking is a **switch on Your trip**, not a one-time button. It sits there
whenever the camp runs passes, and picking an arrival before gates open files
the request in the same write that saves the date — so the tick mark and the
officers' queue are the same fact rather than two that can disagree. Switching
it off records an explicit "no thanks", which is what stops the next change of
dates quietly asking again. Once a pass is actually set aside the switch goes
read-only, because unticking it would either be a lie or a silent hand-back of
something scarce.

The passes themselves are **imported from the vendor's PDF** — the one that
arrives with a pass per page. CampTool reads each page's date, ticket ID,
security code and the scan code behind its QR, and each date's quota becomes
however many passes actually turned up. Re-uploading the same order imports
nothing twice. Officers then **set a pass aside** for someone, which reveals
nothing at all — no codes, no download, not even to officers — and later
**release** it, which hands the codes over and cannot be undone. A pass that
has to be pulled after release is *voided* (admin, with a reason) rather than
returned to the pool, because there is no un-sending a secret.

An **admin** can also allocate a pass **outside the camp** — to a neighbour or
a helper with no account here — by naming them. It leaves the pool like any
other assignment, so it stops counting towards covering the camp's own early
arrivals, and releasing it produces a PDF for the officer to send on, since
there is no camper page for the codes to appear on.

A pass comes from the vendor with the **purchaser's** name printed on it — one
person, repeated on every page of the order, because one person bought the
allocation. On the way out that field is rewritten to the person it's actually
for. The old name is replaced in the page, not painted over, so it isn't left
behind in the text layer; a long name shrinks to fit rather than colliding with
the column beside it; and the finished file is read back to confirm the ticket
ID, date and security code all still say what they did before. If any of that
can't be verified — a font without the right glyphs, a layout the vendor has
changed — the untouched vendor page is delivered instead, because a pass with
the wrong name still opens the gate and a camper with no pass does not.

Released passes are delivered two ways: the vendor's own page, cut out of the
order on demand, and CampTool's own rendering that puts **a whole travel
group's passes on one sheet** — one page for everyone arriving in the same
vehicle, instead of a stack to shuffle through at the gate. Cutting a page is
done by rebuilding it from only what it draws: a PDF page's resource dictionary
lists every image in the document it came from, so a page copied the obvious
way carries every *other* pass's QR code along invisibly.
`bun scripts/audit-sap-pdf.ts <file.pdf>` reports what a PDF shows versus what
it contains, for checking files from anywhere.

All of this is scoped to the active year and goes read-only when that year is
locked.

A **Schedule** organizes what the camp does together — work parties, meetings,
and daily service — with sign-ups. Each day of a gathering is split into
**shifts**: one job, on one day, that needs people. A gathering that repeats
daily can be given a whole **role template** at once (a prep crew, cutters, a
serving push, cleanup — each with its own hours and headcount), stamped across
every day in one action instead of one form submission per role per day;
re-applying it later only fills gaps, and editing a shift in place never
disturbs the people already signed up. What a shift *is* is explained on the
page rather than assumed, and a schedule that's switched on but still empty
hides itself from campers until there's something in it.

**Meetings** is the same data seen the way a camp meeting actually works. An
officer sets one up — once, or on a weekly or fortnightly cadence through a run
of dates — and each one gets three things a work party doesn't. An **agenda**
that *anyone who can see the meeting* may add to, recruits included, so items
arrive during the fortnight rather than being remembered on the call; whoever
added an item can edit or withdraw it, and officers can moderate any of them. A
**join button** for the camp's standing meeting room: an admin pastes one link
on the settings page — a Discord voice channel, or a Zoom, Meet, Teams or Jitsi
room, recognized from the link itself — and every meeting offers it, so there is
never a link to hunt for. And a **summary** afterwards, written by an officer as
a draft that nobody else can see, then *published*, which is what distributes
it: it becomes a to-do on every camper's home page until they've read it. A
meeting scheduled here appears on the Schedule calendar and vice versa — one
thing, two views, not two lists to keep in sync.

A **Spares board** is where campers post a spare ticket or vehicle pass, or ask
for one — asking price optional, with a way to mark it taken so nobody chases
something already gone. Ticket and vehicle pass are separate kinds throughout,
since people routinely have one and need the other. It is deliberately separate
from the camp's own ticket allocation, and the camp is not a party to the
arrangements.

A **Fuel** page records who's bringing what fuel, how much, and in what
containers, and rolls it up per type with container counts and a secondary-
containment tally — the numbers a fire-safety review actually needs. Gallons and
pounds are never added together, and the page flags when the camp has both
liquid fuel and propane, which need separating. "I'm not bringing any" is a
declarable answer, so the review can tell someone who has nothing to store from
someone nobody has heard from. Relatedly, an RV can be marked
as needing **pump-out / cleanout access**, which whoever lays out the map sees
alongside the existing "near my car" preference.

On **Supplies**, campers claim what's listed *and* add what they're bringing
that isn't — with matches from every group shown as they type, so nobody
discovers at the gate that six people brought whiskey and nobody brought ice.

The roster shows **when everyone is actually here**: arrivals per day and how
many people are on site each day, which is the number you need to pick a night
for a camp dinner.

An officer-only **Finances** page tracks the camp's money for the year — donations
in and spends out (with optional member, category, and date) — and shows running
totals (in / out / net balance). It's deliberately not shared with all campers,
and goes read-only when the year is locked.

A **Programming** page organizes what the camp offers the wider event — talks,
workshops, classes, performances. It runs as an open call: any camper proposes
something (title, blurb, kind, rough length) without needing to know the
schedule; officers accept or decline with a note, then give accepted items dates
and times. Scheduling *is* publishing, so nothing goes public without a time and
place. Presenters and co-presenters can be campers, their guests, or an outside
speaker credited by name only (who never lands on the roster or headcount). The
resulting lineup is served at `/c/<camp-slug>/schedule` as a public,
no-login page — the thing to put on a flyer or a QR code — while offerings
marked *camp only* stay internal.

A **Wiki** gives the camp somewhere to write things down that outlive any one
year — how the swamp cooler is plumbed, how the big shade structure goes up,
what went wrong last time. Pages are free-form and **any member can edit any
page**; every save keeps the previous version, so open editing costs nothing and
officers can restore. A page can be **tied to a thing elsewhere in the app** —
most usefully a structure kind, so a camp's signature build shows its page in
the map's side panel for every one placed, this year and every year after (or a
single placed object, when only that one is special). Pages link to each other
with `[[Another page]]`, and to any other part of CampTool with
`[[/map|the camp map]]`, offered from a picker of the features that camp has
turned on.

An **FAQ** answers the questions people actually ask, once. Most of the camp
sees a searchable Q&A list, grouped into categories an officer defines and
collapsed until you open one; searching filters across questions *and* answers
and expands every hit. Officers write the answers — but anyone who can see the
page, recruits included, can **ask a question that isn't there**, which lands in
an officer queue (badged in the nav until it's cleared) and publishes as a
normal entry once answered. Answers are written in the same format as wiki
pages, so an answer can point deep into CampTool — `[[/tickets|request one
here]]` — or straight at a wiki page with `[[Fire safety]]`, both offered from a
picker; the wiki's editor can link back at an individual answer the same way.
Every answer keeps a permanent address of its own (`/faq/how-do-i-get-a-ticket`)
that survives re-wording the question.

**Both take pictures.** Wiki pages and FAQ answers share one body format, so
adding a photo works the same in either — pick a file, paste it, or drag it onto
the box. The **original is kept at full resolution** (the page shows a smaller
copy and links to the original), so the wiki doubles as somewhere the camp's
build photos actually survive. Pictures are camp data like everything else: they
are served only to signed-in members of the camp that uploaded them, never from
a public URL. You can also point at an image hosted elsewhere with
`![caption](https://…)`. Files live in the data directory next to the database,
and the super-admin backup download bundles both, so one file is still a
complete backup.

**Prospects** is where officers keep track of everyone the camp is talking to
but who hasn't joined. Recruiting happens across half a dozen platforms and ends
up scattered across half a dozen inboxes, so this is one shared thread per
person: paste what they said — a screenshot works — along with a link back to
the original post or message, and the next officer to talk to them can read the
whole history first. A prospect needs nothing but a name, since often "Jenny
from the art thread" is genuinely all anyone has; email, phone, and handles on
each platform are added as you learn them. One officer usually shepherds each
conversation, and when several officers turn out to have been talking to the
same person separately, **merging** folds the records into one — both logs
survive and re-sort into a single timeline. Public applications land on the
prospect they already match, and an invite generated from someone's card carries
their history with them when they join. It is **officer-only**, and off until an
admin turns it on.

Officers can also read what the camp actually said: the questionnaire's
**Responses** view breaks answers down by question — with a tally for
multiple-choice and yes/no, and who still hasn't answered — or by person, and
exports to CSV. And the members list shows **who invited who**, which the app
has been recording since invites shipped.

If your camp runs a [bins](https://github.com/cinderblock/bins) instance — the
QR-sticker inventory tracker for what's in which box — a **Bins** shortcut in
the top bar opens it already signed in. The camp admin sets the address and
access code once; the code is handed out only when a member clicks, never
rendered into the page. Members and up get the shortcut; recruits don't.

The deployment owner is a **super admin** (the first account to register; more
can be granted in-app) with a **Site admin** page that controls two
instance-wide lockdowns: turning off **new camp creation** (only super admins can
then create camps) and switching sign-ups to **invite-only** (new accounts can
then be created only by following a camp invite link or a camp's public apply
page — the bare login page won't offer signup). Super admins always bypass both.

## Develop

```sh
bun install
cp .env.example .env   # set PUBLIC_BASE_URL + BETTER_AUTH_SECRET; Discord optional
bun run dev            # http://localhost:17923 (set PORT to change)
```

The SQLite database is created and migrated automatically on first start
(`DATABASE_PATH`, default `./data/camptool.db`). Auth works without Discord
credentials; setting `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` lights up the
Discord login and link features (see [`docs/discord-setup.md`](docs/discord-setup.md)).

Other scripts: `bun run typecheck`, `bun run build`, `bun run start`,
`bun run lint`, `bun run format`. Database: `bun run db:generate` (new
migration from schema changes), `bun run db:migrate`, `bun run db:studio`.

## Deploy

Production runs under Bun and serves over a **unix socket** (no TCP port) so a
reverse proxy can terminate TLS in front of it. `bun run start` boots
`server.ts`, which binds the React Router handler to `$SOCKET_PATH` (default
`/run/camptool/camptool.sock`). The canonical deployment auto-deploys to firefly
on push to `master` (a self-hosted runner stages a release tree that an
in-container supervisor launches; Caddy proxies the public URL to the socket);
for self-hosting elsewhere, a `Dockerfile` + `compose.yaml` build the same socket
server into a container. Both are documented in
[`docs/firefly-deploy.md`](docs/firefly-deploy.md).

## Design notes

- **How joining works** (apply page vs. invite links, the onboarding wizard,
  and the question axes — audience/scope/surface/placement) is documented in
  [`docs/camp-lifecycle.md`](docs/camp-lifecycle.md).
- **Four layers (the app is not Burning-Man-specific):** (1) the **core app**
  framework — users, groups, the onboarding framework, post-event followups, the
  camp/edition/membership skeleton (this repo, event- and camp-agnostic); (2)
  **per-camp theming** — custom structures/questions/branding via the
  `camp-theme` contract; (3) **per-event theming + map/addressing** — events
  differ structurally (Burning Man's BRC annular-clock layout vs. others), so BRC
  geometry, BM ticket/pass flows, and the Burning Man disclaimer live here; (4)
  the **per-camp/event/year data** in the database. The Math Camp camp-theme and
  the Burning Man event layer are bundled in this repo for now but are designed to
  peel out into their own packages. One camp can attend multiple events.
- **Privacy mode is a screen-share convenience, not an access control.** Camp
  admins can flip a per-browser toggle that replaces every name, email, phone
  and Discord handle with deterministic pseudonyms, so the live instance can be
  demoed without building a fake dataset. Pseudonyms are seeded per word on the
  real value, so the same person reads the same everywhere, and names mentioned
  inside free-text notes are swapped too. It is deliberately **read-only** —
  a form pre-filled from pseudonymized data would otherwise save the pseudonym
  over the real record. It is *not* a permission tier: everyone who can turn it
  on could already see the real data. See
  [`plans/privacy-and-demo-mode.md`](plans/privacy-and-demo-mode.md).
- **Multi-camp aware from day one:** every tenant-scoped table carries a
  `camp_id`, even though we run a single deployment now. Avoids a painful
  migration when cross-camp map sharing / multi-camp hosting arrives.
- **Discord without a gateway bot:** DMs and reminders are sent over the Discord
  REST API and slash commands use the interactions webhook — both live inside
  this web server, so the deployment stays a single "little webserver." A
  separate gateway process is only added if a feature needs live events.
- **Per-deployment customization = a camp-theme package, not runtime config.** A
  self-hoster who wants bespoke map structures (or, later, UI overrides) adds a
  workspace package under `packages/` implementing the `@camptool/theme-contract`
  `CampTheme` and points `CAMP_THEME` at it (default → the built-in
  `@camptool/default-theme`). Core reads it through the single `~/theme` module;
  Vite swaps the active package in at build time. Custom map structures contribute
  a `CampStructure` (a palette kind with its own `renderFootprint`), so they slot
  into the map/legend/picker without ever bloating the shared open-source palette.
  `@camptool/mathcamp-theme` is the worked example (its **Sierpinski pyramid**
  landmark — a 3-level Sierpinski tetrahedron drawn as an honest 40′ top-down
  Sierpinski-triangle footprint).
- **Instance admin vs. camp admin:** super admin is the only deployment-wide
  role (stored in a `super_admin` side table, not on `user`, so per-camp identity
  stays clean). Its two toggles live in a singleton `instance_setting` row. The
  invite-only gate runs at better-auth's `user.create` hook so it covers every
  signup method; sanctioned pages (apply/invite) carry a short-lived signed
  cookie that the hook accepts. Note: because better-auth only runs its origin
  check on cookie-bearing requests, production must set `NODE_ENV=production` and
  a `PUBLIC_BASE_URL` matching the browser origin (the deploy env-file does).
- **No mail transport — recovery is a human, not an inbox.** Nothing in this
  deployment can send email yet (`mailEnabled` in `app/lib/auth.server.ts`), so
  no public page offers an email-delivered credential: the magic-link link is
  hidden on `/login`, `/c/:slug` and `/i/:token`, and there is no "forgot
  password?" button anywhere. A reset button that silently mails nothing is
  worse than none — the person waits for a message that never arrives instead of
  asking a human. In its place those pages say plainly that the site sends no
  email and to ask an officer for a recovery link. Officers issue one from the
  members page; it hands the person a **passkey** (password is the fallback) and
  is delivered out-of-band on purpose. See
  [`plans/password-recovery.md`](plans/password-recovery.md). When real delivery
  is wired, flip `mailEnabled` in the same change and the affordances come back.
- **Social groups are relationships, not teams — and not permissions.** A camp
  is a handful of families and friendships that happen to share a lot, so
  members and the roster can be grouped into named **social groups** anyone can
  create: a family, a couple, housemates, the friends somebody brought along.
  They nest as deeply as the relationships do — a household inside the wider
  family — and the who-invited-whom tree (recorded on every invite redemption
  since invites shipped) is shown as an actual tree beside them, with one button
  to turn "everyone so-and-so brought" into a group. Nothing is ever inferred:
  provenance is a fact, a group is a judgement, and a human presses the button.
  Two deliberate boundaries: what the camp *does* together is shifts and roles
  on the **schedule**, not groups; and who you're *camping* with is the one-level
  **party link** ([`plans/party-member-links.md`](plans/party-member-links.md)),
  which is per-year and carries real authority over tickets and passes. A group
  grants **nobody anything**. Keeping those three apart is the whole design. See
  [`plans/social-groups.md`](plans/social-groups.md).
- **Merging duplicate members is direction-agnostic.** When the same person
  signs up twice, an officer cannot know which of the two accounts still has a
  working login — so the merge no longer asks. Every field is settled by a rule
  over both records (highest role, earliest join date, blanks filled from either
  side), the two accounts' passkeys / password / Discord logins fold onto one
  account, and only a genuine disagreement (two different playa names) is put to
  a human. Merging A with B and B with A produce the same person, which
  `bun run e2e:member-merge` asserts by doing both.
