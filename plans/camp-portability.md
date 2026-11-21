# Camp portability: moving one camp between any two CampTool installs

> Task plan. Parent plans: `plans/camptool.md`, `plans/hosting-other-camps.md`
> (step 7 and 8f are the one-way, whole-database move this generalises).
> Plan path: `plans/camp-portability.md`. Branch `camp-portability`.
> **Status (2026-11-20): design revised with Cameron's answers (decisions
> 6–9); waiting on his go-ahead to build. No code yet.**

## Goal

Cameron (2026-11-20): "can we make this export work for all camps in all
directions? If a camp decides to leave camptool.org and self host, it should
be easy for all involved, including letting users keep using their existing
logins, at least for a limited time. also should be easy for other
(re)imports into camptool.org as people move around."

Move **one camp** (not a whole database) between any two installs:

| From | To |
| --- | --- |
| self-hosted (Bun + SQLite) | camptool.org (Worker + D1 + R2, subdomains) |
| camptool.org | self-hosted |
| camptool.org | camptool.org (a camp that left comes back) |
| self-hosted | self-hosted |

"Easy for all involved" means: the camp admin drives it from the UI, members
mostly don't notice (old links forward, old logins work for a while), nothing
written during the move is lost, and nothing that isn't the camp's leaks.

## Environment / context

- Today's tool, `scripts/import-to-d1.ts`, moves a **whole** Bun database onto
  an **empty** D1: refuses a target with users, moves `passkey` →
  `legacy_passkey`, relies on a shared `BETTER_AUTH_SECRET` so old session
  cookies verify, and on the old host's DNS pointing at the new deployment
  (`LEGACY_HOSTS`, `/moved`, `/api/legacy-passkey`, `/handoff`). All of that
  assumes **one operator owns both ends**. A camp leaving for a stranger's
  server breaks every one of those assumptions.
- Math Camp's cutover (2026-11-14, ~1:45–2:30 AM PST, 09:45–10:30Z) lost any
  writes to firefly after the 1:46 AM snapshot. This design freezes the camp
  instead.
- All ids are text UUIDs (no integer PKs), so rows can keep their ids across
  installs. Blobs are keyed `<campId>/…`, so they keep their keys too.
- 67 FKs reference `camp.id`, 38 reference `user.id`. Some JSON columns (map
  snapshots, `pendingPrev`, recruit answers) may hold user ids inside text.
- No email is sent (`mailEnabled = false`), so password users' emails are
  **unverified**. Discord sign-ups carry Discord's verified flag. "Match by
  verified email" therefore rarely applies on its own; see User matching.
- `deleteCamp()` cascades every camp table from `camp`, then deletes blobs
  under `<campId>/`.

## Decisions already made (don't re-ask)

1. Per camp, not per database; must merge into a target that already has users
   and camps. (Cameron's ask.)
2. Logins keep working after a move "at least for a limited time". (Cameron.)
3. Old links forward to the new place for a limited time, whichever side the
   old host is. (Cameron.)
4. Privacy-first: a move never publishes anything; data only goes from one
   install to another install's admin (memory: private-first).
5. Never touch Cloudflare, DNS or ops without Cameron's yes for that change.
   **Nothing in this design needs an infra change**: forwarding and the
   passkey well-known file are served by the app itself.
6. **No passwords carried, passkeys forced.** Password hashes never leave the
   old install. Everyone the import creates must make a passkey on the new
   install on first arrival (the existing `/new-passkey`, no skip, no
   "password instead"). In line with `plans/passkey-first-auth.md`.
   (Cameron, 2026-11-20: "I don't want to support passwords. I want to force
   passkeys, or at least STRONGLY encourage them".)
7. **Forwarding + login window: 1 year** by default, extendable. (Cameron,
   2026-11-20.)
8. **Delete on the source** as soon as the target confirms the import (option
   to keep a read-only copy until window end); at window end, delete source
   accounts left in no camp. (Cameron, 2026-11-20: "ok".)
9. **Anyone may import a camp when camp registration is open**
   (`instance_setting.allow_camp_creation`); when it's closed, only via a camp
   setup link or a super admin. (Cameron, 2026-11-20.)

## Design

### Overview: a move is a handshake between two installs

```
 SOURCE (old home)                                TARGET (new home)
 1. camp admin: "Move this camp"
    → camp frozen read-only
    → move code shown  ─────── admin copies ──────▶ 2. "Import a camp", paste code
                                                    3. target pulls manifest,
    serves manifest, rows, files  ◀──── HTTPS ─────    rows, files (or uses an
    (bearer = code's token)                            uploaded bundle file)
                                                    4. preflight report: schema,
                                                       slug, packs, user matches
                                                    5. import (resumable steps)
    6. records target URL, ◀── signed "done" ──────
       starts forwarding window
 7. data deleted (default: now);
    tombstone + login bridge live until window end
```

Both sides must run a CampTool release that has this feature. Neither side
needs the other's secrets, DNS, or operator.

### The move code

`camptool-move:1:<source origin>:<move id>:<secret>` (one line, copy/paste).

- `<secret>` is 32 random bytes, base64url. Its SHA-256 is the bearer token
  for the pull API; the secret itself is the AES-256-GCM key when the bundle
  travels as a file. The source stores only a hash.
- Single target: the first install to finish the pull binds the move to its
  origin; the code is then dead for anyone else.
- Expires if unused (default 7 days); cancelling unfreezes the camp.

### Bundle format (`.camptool`, format version 1)

One logical format, two transports: served piecewise by the pull API, or as a
single file (tar.gz, then AES-256-GCM with the code's secret) for air-gapped
moves or targets that can't reach the source.

```
manifest.json
  format: "camptool-camp", formatVersion: 1
  app: { version, commit }
  schema: { migrations: [<every applied migration tag>] }
  source: { origin, rpId, campUrl }
  move: { id, publicKey }            Ed25519, for login hand-offs
  camp: { id, slug, name }
  tables: { <name>: { columns: [...], rows: n, sha256 } }
  files: [ { key, size, sha256 } ]
  users: { exported: n, stubs: n }
rows/<table>.jsonl                   one row per line, keyed by column name;
                                     BLOBs as {"$b64": "..."}
files/<campId>/...                   blob keys unchanged
```

- **Integrity**: each table file and blob has a SHA-256 in the manifest; the
  manifest is signed with the move's Ed25519 key. In pull mode the target
  fetches the public key from the source over TLS, so the signature also
  proves origin. Any mismatch aborts before writing.
- **Schema drift**: rows are keyed by column name, and the manifest lists the
  source's migrations. Rules, checked in preflight:
  - Target missing any source migration → refuse ("update this install
    first").
  - Same migrations → straight import.
  - Target ahead: the **CLI** loads rows into a scratch SQLite built from the
    target's migrations up to the source's last tag, then runs the remaining
    migrations over it (same trick as `import-to-d1.ts`), then imports. Exact,
    including data migrations.
  - The **UI on Workers** has no scratch SQLite. It imports when every
    in-between migration is *additive* (new tables, new nullable or defaulted
    columns), checked mechanically from the two column sets; otherwise it says
    to use the CLI, or to update the source first. Recommended procedure for
    every move: update the source to the latest release before starting.

### What a camp's export contains (and never contains)

A registry, `app/lib/camp-move/tables.ts`, classifies **every** table, with a
test that fails on any unclassified table (same idea as
`privacy-coverage.test.ts`). Classes:

| Class | Rule | Tables (examples) |
| --- | --- | --- |
| camp | the `camp` row, and every row reachable from it by FK path | membership, map, attendee, wiki, … (derived from the Drizzle FK graph) |
| member identity | only the camp's people: users with a `membership` or `recruit_application` in this camp (`PEOPLE_SOURCES`) | `user`, `account` (Discord links only, never password rows), `passkey` public keys |
| not coming | users camp rows point at who aren't the camp's people (a site admin, someone whose membership is gone) | nothing: nullable references cleared, rows that need them left out, cascading like the schema's FKs (same as deleting that account). Counted in `manifest.dropped` |
| never | instance, transient or other-tenant | password hashes (`account.password`, credential-provider rows), `super_admin`, `instance_setting`, `camp_setup_link`, telemetry, `session`, `verification`, `password_reset`, `user_email_alias`, other camps' memberships |

- Discord `account` rows carry `provider_id` + `account_id` (the Discord user
  id, an identifier, not a secret); access/refresh tokens are dropped (they
  belong to the source's Discord app). On a target with Discord configured,
  Discord sign-in then just works, indefinitely.
- Passkeys go across as `legacy_passkey` (public key + credential id, not
  secrets) with the source's RP ID.
- JSON columns that can hold user ids get an explicit registry entry with a
  rewrite function (needed for user id remapping); the test fails on a JSON
  column that isn't listed as "no user ids" or given a rewriter.

### Importing: merge rules

All writes are INSERTs; nothing in a bundle can update or overwrite an
existing target row, except the explicit re-import replace below.

- **Camp id** kept. If the target already has that camp id:
  - only a tombstone (it moved away from here earlier) → import, clear the
    tombstone (the camp is back);
  - a live camp → refuse, unless the target's super admin chooses **Replace**
    (a backup is taken first, then `deleteCamp`, then import).
- **Slug**: kept if free and valid; otherwise the importer picks a new one
  (same picker as camp setup). The old slug is remembered for forwarding.
- **Any other PK collision** (a row id that already exists outside this camp)
  aborts the import. UUIDs make this only happen with a crafted bundle.
- **Structure packs** the target doesn't bundle: preflight warns and lists the
  kinds that won't render; the import still carries the rows, so they come
  back if the pack is added.
- **Discord server id** carries; the post-import checklist says to invite the
  target's bot.
- Atomicity: Bun runs it as one transaction. D1 runs it in resumable batches
  under a `camp_move_in` row in state `importing`; the camp stays hidden
  (not reachable, not listed) until the last step flips it live, and a failed
  import can be rolled back with `deleteCamp`.

### User matching (the hard part)

For each exported member, by email (case-insensitive, also against target
`user_email_alias`):

| Situation | Result |
| --- | --- |
| no target user with that email | **create**: new user, keeps source user id, carries Discord link and passkeys (as legacy); never a password; must make a passkey on arrival |
| target user exists, and identity is **proven**: both sides verified, or both have the same Discord account id | **link**: map source id → target id; camp rows rewritten to the target id; **no credentials added** to the existing account |
| target user exists, not proven | **claim**: a placeholder user (hidden email) owns the camp rows; the person resolves it by signing in to the existing account and arriving via the source's login bridge (proving both), which runs the existing account merge. Unclaimed at window end → stays a placeholder the camp's officers can merge or remove |

Why not just match by email: no email is ever verified for password users, so
anyone could sign up on camptool.org as `someone@x` before a camp moves in;
auto-linking would hand that squatter the real person's camp profile. And a
hostile source (a self-hoster controls their own DB) must never be able to add
a password or passkey to an existing target account, which is why linked users
get no credentials.

Preflight shows the importer the counts (create / link / claim) with names,
before anything is written.

### Logins after a move

No shared `BETTER_AUTH_SECRET`; sessions are not exported. Instead, three
paths, all limited to the **forwarding window** and to users the move
**created or is claiming** (never linked users, who already have a login on
the target):

1. **Login bridge (works for every sign-in method).** The old install keeps
   serving its sign-in page for the moved camp. Someone signs in there as
   usual (session cookie, password, Discord, or their old passkey), and the
   old install redirects them to the target's `/handoff` with a token signed
   by the move's Ed25519 key: `{iss: source origin, aud: target origin, sub:
   source user id, move, exp: +2 min, jti}`. The target checks signature,
   audience, expiry, single use (`jti`), and its source→target user map, then
   signs them in. A GET with a still-valid old session cookie does this
   automatically, as `LEGACY_HOSTS` does today.
2. **Old passkeys directly on the new site (WebAuthn Related Origin
   Requests).** During the window the old install serves
   `/.well-known/webauthn` with `{"origins": [<target origins>]}`, which lets
   the target's login page call `navigator.credentials.get({ rpId: <old RP
   ID> })`. The target verifies against `legacy_passkey` with the old RP ID
   and its own origin. Chrome/Edge 128+ and Safari 18+ support it; elsewhere
   the button falls back to path 1. Browsers cap the list at 5 distinct
   registrable domains, so an install with more than 5 concurrent departures
   lists the newest 5 and the rest use path 1. Safe for the old install:
   its own verifier still accepts only its own origins.
3. **Discord** (permanent while the target allows Discord sign-in): the
   carried link matches on Discord user id.

Whatever path they arrive by, a created user with no passkey on the target is
sent to `/new-passkey` (existing forced flow: no skip, sign-out only). No
password is ever set or carried (decision 6). Someone whose browser can't
make a passkey gets the officer-issued re-enrollment path from
`plans/passkey-first-auth.md`.

### Forwarding old links

Source keeps a `camp_move_out` row (survives the camp's deletion):
`{id, campId, oldSlug, oldHosts, targetCampUrl, targetOrigin, publicKey,
privateKey (encrypted with BETTER_AUTH_SECRET), state, windowEndsAt}`.

- Any request for the moved camp (its subdomain on camptool.org, `/c/<slug>`,
  or on a single-camp self-host the whole host once no other camp is left)
  redirects path-for-path to the new home, reusing `movedTarget()`. Signed-in
  GETs go through the login bridge, so they arrive signed in.
- On camptool.org this is a DB row, not a DNS or ops change. A self-hoster
  keeps their server up (it can shrink to the bridge only) until the window
  ends, or loses forwarding and the bridge early: their call, shown clearly.
- The window defaults to **1 year** (decision 7) and is extendable by the source's camp admin or super admin.
  `LEGACY_HOSTS` stays as the special case for a same-deployment move (Math
  Camp) and can later become a `camp_move_out` row.

### Freezing and deleting on the source

- **Freeze** from "Move this camp" until the target reports done or the move
  is cancelled: every write action for that camp is refused with a banner
  ("This camp is moving to …"). Reads work. This is what the Math Camp
  cutover lacked.
- **Delete after export**: when the target's signed "done" arrives, the camp
  data is deleted with `deleteCamp` (default on; the admin can choose "keep a
  read-only copy until the window ends"). The `camp_move_out` tombstone and
  the moved users' accounts stay, because the login bridge needs them.
- **Window end**: tombstone removed, forwarding stops, `/.well-known/webauthn`
  drops the origin, and users who are now in no camp on the source (and
  aren't super admins) are deleted (open question 3).

### Who can do what

- **Export / move out**: the camp's admins, or a super admin (for a camp whose
  lead is gone). Not while impersonating. Source super admins see every
  pending and recent move on Site admin → Camps.
- **Import on any install**: anyone allowed to create a camp there (camp
  registration open, decision 9), through the same "start a camp" flow with an
  "Import an existing camp" choice; when registration is closed, through a camp
  setup link (the step 9 flow) or by a super admin. The importer
  must be one of the camp's admins in the bundle (matched to themselves) or a
  super admin; otherwise someone could import a camp they don't run.
- The CLI needs direct database access, so it is an operator tool.
- **CLI** (`scripts/camp-move.ts`): `export`, `inspect` (manifest + checks,
  no secret needed for the manifest), `import` (pull by code or from a file;
  `--dry-run` prints the preflight report). The CLI works against a Bun
  database directly or a D1 via wrangler, replacing `import-to-d1.ts` for
  camp moves (that script stays for whole-database restores).

### Pull API (source side, all bearer = hash of the code's secret)

- `GET /api/move/<id>/manifest`, `GET /api/move/<id>/rows/<table>`,
  `GET /api/move/<id>/files/<key>` (one file per request, so D1/Workers
  limits never see a giant body; the target streams files straight to its
  blob store).
- `GET /api/move/<id>/key` (public key, no secret needed).
- `POST /api/move/<id>/done` signed by the target with the bearer, carrying
  the target camp URL and origin.
- None of these routes render a page or appear in navigation. All return 404
  unless a move with that id is in the right state.

## Plan / steps

1. [x] Open questions answered (decisions 6–9, 2026-11-20).
   [ ] **Current step: Cameron's go-ahead to build.**
2. [x] Table registry + classification test; JSON user-id registry
   (`app/lib/camp-move/registry.ts`, `schema-graph.ts`).
3. [~] Exporter (`export.server.ts`), people remap (`remap.ts`), bundle
   format, signing, move code, encrypted single file (`bundle.ts`). Unit
   tests green. **Next:** `scripts/camp-move.ts export|inspect`.
4. [ ] Importer on Bun: preflight (schema, slug, packs, user matching),
   create/link/claim, re-import and Replace. CLI `import --dry-run`.
5. [ ] Importer on D1 (resumable batches, files to R2).
6. [ ] Move handshake: move code, freeze, pull API, done callback, UI on both
   sides (camp settings → "Move this camp"; setup link / Site admin →
   "Import a camp").
7. [ ] Logins: signed hand-off, claim flow, `/.well-known/webauthn` + direct
   legacy passkey sign-in, forced new credential.
8. [ ] Forwarding, delete-after-move, window expiry cleanup.
9. [ ] e2e in all four directions (two local installs: Bun and `wrangler
   dev`), browser test for Related Origin Requests with a virtual
   authenticator (`camptool.test` style names, see hosting plan Findings).
10. [ ] Docs: `docs/moving-a-camp.md` for camp admins and self-hosters;
    README pointer.

## Findings / gotchas

- Every camp table but one carries a NOT NULL `camp_id`;
  `setup_pass_stock_event` reaches the camp through `setup_pass_stock`.
  `campTables()` derives both kinds of path.
- `map_snapshot.data` is whole `select()` rows (JS keys) and restoring one
  re-inserts them, so the `createdById` inside must be remapped like a real
  column (`JSON_COLUMNS`). Other structured columns hold no user ids.
- `structure_kind.value` is unique site-wide (`x-<random>`); a clash on import
  is treated like any other unique conflict (abort).
- `legacy_passkey` rows from an earlier move are not carried: their RP ID is a
  third host no browser will use at the new address.

- (Design-time) Passkeys can't change RP ID. Related Origin Requests lets a
  different origin use the old RP ID's passkeys, only while the old RP ID's
  host serves the well-known file; that's why both sides must cooperate.
- (Design-time) Unverified emails everywhere: email match alone is not proof
  of identity, see User matching.

## Progress log

- [x] 2026-11-20: design written (this file).
- [x] 2026-11-20: Cameron's answers folded in: no passwords, 1-year window,
  delete on confirm, open imports when camp registration is open.

## Open questions for the user

(None; answers recorded as decisions 6–9.)

## Things not to do

- Don't carry or accept password hashes.
- Don't share `BETTER_AUTH_SECRET` between installs, or export sessions.
- Don't add credentials to an existing target account from a bundle, and
  don't honour hand-offs for linked users.
- Don't auto-link users on an unverified email match.
- Don't upsert from a bundle; INSERT only.
- Don't move a camp without freezing it.
- Don't touch Cloudflare, DNS or ops for any of this without Cameron's yes.
