# Passkey-first auth (design + build plan, 2026-08-07)

> Plan path: `plans/passkey-first-auth.md`
> Parent plan: `plans/camptool.md`.
> Supersedes the OAuth-expansion half of `plans/auth-and-discord-policy.md`;
> **keeps** that doc's core distinction and its `discordPolicy` ladder.

## Goal

Make **passkeys the way you sign in to CampTool** — no password required to
create an account, no dependency on a Meta/Google/Discord account to get in.
Cameron's framing: passkeys are the new best universal login standard and don't
require a big-company account.

Three asks, verbatim:

1. New members are **required** to set up a passkey.
2. Existing members are **directed** to set one up.
3. An **admin dashboard** showing how many people have enabled it. Explicitly
   maybe-temporary — on a fresh install where every account has a passkey there
   is nothing to track.

## The constraint that shapes everything

**Auth credentials are account-scoped; a CampTool account can belong to many
camps** (decision #1 in `plans/camptool.md` — multi-camp aware, single deploy).

Consequences, and they are not negotiable without a foundational reversal:

- Sign-in happens at `/login` **before any camp is known**. There is no camp
  context to apply a camp policy to.
- If Camp B permits passwords, that user's password works everywhere,
  including at Camp A. **Camp A cannot revoke a credential it doesn't own.**

`plans/auth-and-discord-policy.md` already locked this shape for Discord:
*auth stays instance-wide and permissive; per-camp policy is a membership
requirement, not a login requirement.* Passkey policy takes the same shape,
which is why the two ladders can share machinery.

## Decisions already made (don't re-ask)

From Cameron, 2026-08-07:

1. **Recovery = both, sequenced.** Officer-issued one-time re-enrollment link
   **first** (no new infrastructure). Self-serve email recovery **later**, once
   a real mail transport exists. Rationale: CampTool has *no* mail transport
   today — `magicLink.sendMagicLink` only `console.log`s the URL
   (`app/lib/auth.server.ts:127-133`), so email recovery is not currently
   buildable, and a camp has real-world social trust to fall back on.
2. **Cutover = grace period, then flip a switch.** Legacy methods (password,
   magic link, Discord) keep working. Users without a passkey are pushed to
   enroll. An instance setting later disables legacy sign-in. **Nobody gets
   locked out of the live deployment.**
3. **Per-camp auth policy controls doors + a membership requirement** — NOT
   which credentials exist on an account. A camp chooses which sign-in buttons
   appear at *its* doors (`/c/:slug`, `/i/:token`) and whether an enrolled
   passkey is required to *use* that camp. Passkey is always offered and always
   the primary call-to-action, everywhere.
4. **Adoption stats live on the per-camp members page** — a column plus an
   "N of M enrolled" summary. Officers are the people who actually chase
   someone down, and it's the natural home for the "Reset passkey" action.
   (Cameron picked this one only; the `/admin` instance-wide card is therefore
   *not* in scope except for the legacy-login kill switch, which has to live
   there because it's a deployment-level setting.)

## Environment / context

- better-auth **1.6.14**, `@better-auth/passkey` **1.6.14** (separate package
  in 1.6.x — see the pin note in `plans/camptool.md`).
  `@simplewebauthn/{browser@13.3.0,server@13.3.1}` transitively.
- Live deployment: `camptool.mathcamp.us`. Dev: port **17923**.
- Current auth config: `app/lib/auth.server.ts` (143 lines) — plugins are
  `organization` / `magicLink` / `passkey`, plus `emailAndPassword` and a
  conditional Discord `socialProvider`.
- Client: `app/lib/auth-client.ts` (19 lines) — `organizationClient`,
  `magicLinkClient`, `passkeyClient`.
- No middleware. Guards are called directly in loaders and `throw redirect(...)`
  (`app/lib/session.server.ts`: `requireUser` → `resolveActiveCamp` →
  `requireActiveCamp` → `requireActiveEdition`).

## Findings from reading the installed packages (all verified, 2026-08-07)

These were read out of `node_modules`, not recalled — they de-risk the core.

1. **Passkey-first signup IS supported in 1.6.14.** The plugin accepts
   `registration: { requireSession, resolveUser, afterVerification, extensions }`
   (`dist/index-BoC1i3hA.d.mts:86-117`). With `requireSession: false`, if there
   is no session, `resolveRegistrationUser` calls our `resolveUser({ctx, context})`
   (`dist/index.mjs:22-48`). **This is the whole ballgame** — the previous
   assumption baked into the codebase, that passkeys can never create a user,
   is now false.
2. **The client can pass `context` through.** `registerPasskey` forwards
   `opts.context` as a query param to `/passkey/generate-register-options`
   (`dist/client.mjs:69-77`). So `authClient.passkey.addPasskey({ context })`
   is enough — **no custom endpoint required.**
3. **`afterVerification` can redirect the credential to a different user id.**
   It may return `{ userId }`, which overrides `targetUserId` before the
   passkey row is written (`dist/index.mjs:338-350`). The
   "you-are-not-allowed" guards around it only fire when a session exists.
4. **`verify-registration` does NOT create a session.** It returns the passkey
   row and stops (`dist/index.mjs:363-367`). After a passkey *signup* the
   client must call `signIn.passkey()` to actually get logged in.
5. **`authenticatorSelection` is a first-class plugin option**
   (`dist/index-BoC1i3hA.d.mts:~152`) and we currently set **none**.
   `signIn.passkey()` with no email is a *discoverable-credential* ceremony, so
   this needs `residentKey: "required"` to be reliable. Today it works by luck
   of platform defaults.
6. **The challenge round-trips through the `verification` table**, carrying
   `{expectedChallenge, userData, context}` as JSON
   (`dist/index.mjs:315-320`), consumed once. So `userData.id` chosen at
   options time is what gets baked into the credential as the WebAuthn user
   handle — see the orphan-user gotcha below.
7. **`createWithHooks` reads an AMBIENT request context**
   (`dist/db/with-hooks.mjs:7`, `getCurrentAuthContext()`), not the `void 0`
   that `internalAdapter.createUser` passes explicitly. This is why the
   existing invite-only hook can see request headers at all, and why it keeps
   working on the passkey path.
8. **`createWithHooks` creates with `forceAllowId: true`**
   (`dist/db/with-hooks.mjs:28`), so `createUser({ id, … })` honors a
   caller-supplied id. That's what makes the pre-generated-id design work.

## Design

### Layer 1 — instance: which methods exist at all

Extend the `instance_setting` singleton (`db/schema/instance.ts:19-33`):

```ts
// When false, password / magic-link / OAuth sign-in is refused instance-wide.
// The end state of the passkey migration; flipped from /admin once adoption
// is complete. Passkeys are never disableable.
allowLegacyLogin: integer("allow_legacy_login", {mode: "boolean"}).notNull().default(true),
```

Enforced **server-side**, not just by hiding buttons — a `before` hook on
sign-in that throws `APIError("FORBIDDEN")` when `allowLegacyLogin` is false.
Hiding the UI alone is not enforcement.

### Layer 2 — camp: doors + membership requirement

Columns on `camp` (mirroring where `discordPolicy` is headed, so the two stay
symmetric and could later share a `camp_policy` concept):

```ts
authOfferEmail:   boolean, default true   // show email/password at THIS camp's doors
authOfferDiscord: boolean, default true   // show Discord at THIS camp's doors
authPasskey:      'encouraged' | 'required', default 'encouraged'
```

- **Doors** = `/c/:slug` (public apply) and `/i/:token` (invite redeem), both
  of which render `app/components/AuthInline.tsx` and both of which *do* have
  camp context. `AuthInline` takes an `offers` prop and renders accordingly.
  Passkey is always shown and is promoted to the primary button.
- **Generic `/login`** has no camp, so it offers passkey primary + whatever the
  *instance* still allows. This asymmetry is inherent, not a bug — document it.
- **`required`** = an enrolled passkey is a condition of using this camp, in
  the same spirit as the required-questions gate. Enforcement in Layer 4.

Note this is a **policy, not a feature** — so it does *not* get a `FeatureKey`
in `app/lib/features.ts`. It belongs with the camp settings surface. (The
features registry header comment already carves out core surfaces this way.)

### Layer 3 — passkey-first signup (the technical core)

Configure the plugin:

```ts
passkey({
  rpID: new URL(baseURL).hostname,
  rpName: "CampTool",
  origin: baseURL,
  authenticatorSelection: {
    residentKey: "required",
    requireResidentKey: true,
    userVerification: "preferred",   // not "required": avoids hard-failing
  },                                 // authenticators without UV capability
  registration: {
    requireSession: false,
    resolveUser: async ({ ctx, context }) => { /* see below */ },
    afterVerification: async ({ ctx, context, user }) => { /* see below */ },
  },
})
```

**Flow — "create your account" with no password:**

1. The door collects **name + email** (still wanted: email is the camp's
   contact channel and the officer's handle on a person — it is simply no
   longer a *credential*).
2. Server mints a **pending-signup token**: a signed, short-TTL (10 min)
   payload `{ userId: <pre-generated id>, name, email, inviteToken? }`, stored
   server-side in the `verification` table (reuse better-auth's own store —
   no new table) and referenced by an opaque id.
3. Client calls `authClient.passkey.addPasskey({ context: <that opaque id> })`.
4. `resolveUser({context})` loads the pending signup and returns
   `{ id: userId, name: email, displayName: name }` — **the pre-generated id**,
   so the WebAuthn user handle matches the row we are about to create.
5. `afterVerification({context})` creates the `user` row with **exactly that
   id**, consumes the pending token, and returns `{ userId }`.
6. Client calls `signIn.passkey()` to obtain a session, then proceeds
   (invite redemption / apply flow) as it does today.

**Why pre-generate the id instead of creating the user in `resolveUser`:** if
the user aborts the browser's WebAuthn prompt — extremely common on first
contact with passkeys — creating the row in `resolveUser` leaves an **orphan
user with no credential and no way to sign in**, which then squats the unique
email and blocks the retry. Creating it in `afterVerification` means the row
appears only after a cryptographically verified credential exists. Pre-
generating the id (rather than letting `afterVerification` mint a fresh one)
keeps the credential's user handle consistent with the account.

> ⚠️ **The invite-only gate.** `databaseHooks.user.create.before`
> (`app/lib/auth.server.ts`) is the single chokepoint for the invite-only
> lockdown, and its comment reasoned *"passkey never creates a user, so it's
> exempt."* **That reasoning dies with this change.** Getting it wrong turns an
> invite-only deployment into an open one.
>
> **RESOLVED (2026-08-07), verified by test.** We create the user via
> `ctx.context.internalAdapter.createUser`, which routes through
> `createWithHooks` — so the `before` hook **does** fire, and it picks the
> request context (hence the unlock cookie) out of async storage rather than
> the explicitly-passed `void 0`. We *also* re-check the gate in `resolveUser`,
> so an invite-only deployment refuses **before** the WebAuthn prompt instead
> of after it. `e2e/passkey-invite-gate.ts` asserts both directions.

### Layer 4 — enrollment enforcement

Two different strengths, matching Cameron's wording ("required" vs "directed"):

- **New members — required.** They arrive through a door, and the door's signup
  path *is* passkey registration, so enrollment is structural: there is no way
  to finish signup without a passkey. Nothing extra to enforce.
- **Existing members — directed.** In `app/routes/dashboard/layout.tsx` (which
  already hosts the one forced redirect in the app, the `wizardStep === 0` →
  `/start` jump at lines 59-85), add: if the user has zero passkeys, show a
  persistent, dismissible-per-session banner plus a nav item pointing at the
  new account page. **Not** a hard block.
- **Camps with `authPasskey: 'required'`** escalate the same check to a
  full-screen interstitial before camp content — same machinery, different
  strength, driven by the camp column.

Passkey count is per-*user*, so it must be resolved in the layout loader (one
`count(*)` on `passkey` by `userId`), not per-membership.

### Layer 5 — recovery (officer-issued)

New table, camp-scoped (an officer of a camp may only reset a member of *that*
camp — the multi-camp invariant applies to recovery too):

```
passkey_reset — id, camp_id, user_id, issued_by_membership_id,
                token_hash, expires_at (24h), used_at, created_at
```

- Officer clicks **Reset passkey** on a member row → one-time link.
- Store a **hash** of the token, never the token — same reasoning as any
  bearer credential.
- Redeeming it: creates a short-lived session scoped to *only* the enroll
  action, walks them through `addPasskey`, then **revokes their existing
  passkeys and all active sessions** (a reset implies the old device is gone
  or compromised).
- **An officer must not be able to reset a user who outranks them** — reuse
  the `canImpersonate` rank logic in `session.server.ts:165-194`, which
  already encodes "strictly out-rank the target". A member-level reset that
  lets an officer seize an admin account is a privilege-escalation hole.

Email self-serve recovery is **deferred** until a mail transport exists.

### Layer 6 — passkey management UI (gap being closed)

There is currently **no passkey management anywhere** — the only registration
UI is a card on the Overview (`app/routes/dashboard/index.tsx:425-438`) calling
`addPasskey({ name: "My device" })` with a hardcoded name, no list, no rename,
no delete. Passkey-only makes that untenable. New route `/account`:

- List enrolled passkeys (name, device type, backed-up, created, last used).
- Add / rename / delete — the plugin already exposes `listUserPasskeys`,
  `updatePasskey`, `deletePasskey`.
- **Refuse to delete the last passkey** when legacy login is disabled, or the
  user locks themselves out in one click.
- Prompt for a device name at enrollment instead of hardcoding "My device".

### Layer 7 — adoption stats

On the members page: a passkey ✓/✗ column and an "N of M enrolled" summary,
officer-visible. Deliberately cheap to delete later, per Cameron's note.

`/admin` gets **only** the `allowLegacyLogin` kill switch (a deployment-level
setting has nowhere else to live), not an adoption card.

## Schema / migration summary

| Change | Table | Note |
|---|---|---|
| `allow_legacy_login` bool default 1 | `instance_setting` | the kill switch |
| `auth_offer_email` bool default 1 | `camp` | door control |
| `auth_offer_discord` bool default 1 | `camp` | door control |
| `auth_passkey` text default `'encouraged'` | `camp` | membership req. |
| new table | `passkey_reset` | officer recovery |
| **unique index on `credential_id`** | `passkey` | **see gotcha** |

Defaults are chosen so the migration is a **no-op for existing camps** — the
live deployment keeps behaving exactly as it does today until someone flips
something.

Generate with `bun run db:generate`; **`bun run db:migrate` does not work in
this repo** (drizzle-kit needs a node SQLite driver we don't install) —
migrations apply on app start via the bun-sqlite migrator in
`db/client.server.ts`. Also mind the known `db:generate` no-TTY rename-split
gotcha. Verify on a `VACUUM INTO` copy of the live DB before restarting.

## Gotchas / risks

- **`passkey.credential_id` has no unique index** (`db/schema/auth.ts:90-104`,
  unchanged since migration 0000). Authentication looks credentials up by this
  value; without uniqueness a duplicate row is a real authentication-integrity
  problem. Fix it in this work. Check for existing dupes before adding the
  index or the migration will fail on the live DB.
- **RP ID binds passkeys to a hostname.** `rpID` is derived from
  `PUBLIC_BASE_URL`. Passkeys enrolled on `camptool.mathcamp.us` **will not
  work** on localhost dev, and **changing the production domain would
  invalidate every enrolled passkey for every user**.
  **SETTLED 2026-08-08 (Cameron): the domain is `camptool.mathcamp.us`**, so
  rpID = `camptool.mathcamp.us`. The `tool.mathcamp.us`/`mathcamp.us` musing in
  `plans/camptool.md` is NOT happening; if it ever does, it is a full
  re-enrollment event for every user and needs its own plan.
- **A WebAuthn RP ID must be a DOMAIN — an IP address cannot host a passkey
  ceremony.** So `http://127.0.0.1:17923` and `http://[::1]:17923` are
  unusable for passkey testing even though they're valid secure contexts;
  only `localhost` works. Compounding it, **the dev server binds `::1` ONLY**
  (verified: `127.0.0.1` gets connection-refused, `localhost` and `[::1]`
  get 200) — so the one address that works for both is `localhost`.
- **The dev server's `PUBLIC_BASE_URL` must match the URL you test at**,
  because `rpID` and `origin` derive from it. `.env` points at
  `https://camptool.isozilla.com` — a scratch tunnel that is **down** (verified
  2026-08-08: returns an empty body). Production `camptool.mathcamp.us` is
  fine; only the scratch tunnel is dead. Local passkey testing therefore needs
  an explicit override:
  `PUBLIC_BASE_URL=http://localhost:17923 bun run dev`.
- **`curl -o /dev/null -w "%{http_code}"` gives FALSE NEGATIVES here** —
  it reported `000` for `camptool.mathcamp.us` while the site was serving
  normally, which briefly led this plan to claim production was unreachable.
  Check reachability by fetching the body and measuring it
  (`curl -s URL | wc -c`), or dump headers with `-D`.
- **Playwright HANGS under Bun; run it under Node.** `chromium.launch()` never
  returns and never times out when the script is run with `bun`, but works
  instantly under `node --experimental-strip-types` (Node 24.18). Playwright
  spawns a Node driver process and doesn't survive Bun's process model. Hence
  `e2e:passkey` uses `node`, while `e2e:passkey-gate` (no browser) uses `bun`.
  This is a repo-wide caveat for the "Playwright for E2E" stack decision.
- **Name E2E files `*.ts`, not `*.spec.ts`** — `bun test` globs the latter and
  would try to run browser tests with no server up, breaking `bun run test`.
- **Not every visitor can do WebAuthn** — an old browser, a locked-down
  corporate device, a shared/kiosk machine. This is precisely what the camp's
  `authOfferEmail` door setting and the grace period are insurance against.
  Don't remove the escape hatch on the theory that everyone has a modern phone.
- `verify-registration` writes `createdAt` but there is **no `updatedAt`
  column** on our `passkey` table. `updatePasskey` may expect one — check
  before wiring the rename UI.
- **`signIn.passkey()` needs discoverable credentials.** Anyone who enrolled
  *before* `residentKey: "required"` lands may have a non-discoverable
  credential that usernameless sign-in can't find. The population is tiny (the
  Overview card is the only enrollment path that ever existed), but check the
  live `passkey` table's row count before assuming zero impact.

## Plan / steps

Ordered so nothing lands half-enforced. **Step 1 is a spike, deliberately** —
it retires the only assumption that could invalidate the rest of the design.

- [x] **1. Spike passkey-first signup — DONE, all green (2026-08-07).**
      Landed `app/lib/passkey-signup.server.ts` (pending-signup store on the
      `verification` table), the plugin `registration` wiring in
      `auth.server.ts`, `POST /api/passkey-signup`, a throwaway
      `/spike/passkey` harness, and two test suites driven by a CDP virtual
      authenticator. **Proven:** account creation with no password anywhere;
      the credential is discoverable; sign-out really clears the session and
      usernameless `signIn.passkey()` then signs the same account back in; an
      aborted ceremony leaves no orphan user squatting the email; and the
      invite-only lockdown still refuses the passkey path (403) while allowing
      it when open signups are on. 9/9 + 2/2 checks pass.
- [ ] 2. Schema + migration (all six changes above), verified on a VACUUM copy.
- [ ] 3. `authenticatorSelection` + the `credential_id` unique index.
- [ ] 4. `/account` page — list / add / rename / delete, with the
      last-passkey guard. Retire the hardcoded Overview card.
- [ ] 5. Passkey-first signup in `AuthInline` (doors) and `/login`, passkey as
      the primary CTA everywhere.
- [ ] 6. Camp `authPolicy` — settings UI + door filtering + the `required`
      interstitial.
- [ ] 7. Officer recovery: `passkey_reset`, the members-page action, the
      redeem route, rank check, revoke-old-passkeys-and-sessions.
- [ ] 8. Members-page adoption column + summary.
- [ ] 9. `allowLegacyLogin` kill switch on `/admin`, **enforced server-side**.
- [ ] 10. Docs: `README.md`, a `docs/passkeys.md` for self-hosters, and update
      `plans/camptool.md` decision #3 (which currently reads "Discord +
      email/password + magic link + passkeys" as co-equals).

Deferred, explicitly: self-serve email recovery (needs mail transport);
additional OAuth providers (`plans/auth-and-discord-policy.md` §1 — the
passkey push reduces the motivation, but the doc stays valid).

## Things not to do

- **Don't remove password/magic-link/Discord code paths in this work.** The
  grace period is the whole cutover strategy; deleting them strands live users.
  The kill switch is the mechanism, not deletion.
- **Don't make the camp auth policy a `FeatureKey`.** It is a policy, not an
  opt-in feature, and the features registry deliberately excludes core surfaces.
- **Don't gate login on camp policy.** It is unenforceable across camps (see
  "The constraint"), and pretending otherwise produces a security theatre
  setting that officers will trust and that doesn't hold.
- **Don't create the user row in `resolveUser`.** Aborted WebAuthn ceremonies
  would leave orphan accounts squatting unique emails.
- **Don't let an officer reset a passkey for someone who outranks them.**
- **Don't drop the email field from signup.** It stops being a credential; it
  does not stop being how a camp reaches a person.

## Open questions for the user

1. ~~Final production domain.~~ **ANSWERED 2026-08-08: `camptool.mathcamp.us`.**
   rpID is settled; see the RP-ID gotcha above.
2. Should `authPasskey: 'required'` block **officers/admins** too, or only
   members? *Recommendation: everyone — an admin without a passkey is the
   account most worth protecting.*
3. When legacy login is finally disabled, do we **delete** stored password
   hashes and OAuth `account` rows, or just refuse to accept them?
   *Recommendation: refuse first, delete after a cooling-off period — deletion
   is irreversible and the rollback path matters more than the tidiness.*

## Progress log

- [x] 2026-08-07 — Requirements gathered; five decisions locked with Cameron
      (recovery, cutover, per-camp policy scope, stats placement).
- [x] 2026-08-07 — Audited the existing auth layer (config, client, routes,
      schema, guards, wizard, features registry).
- [x] 2026-08-07 — **Verified in `node_modules` that `@better-auth/passkey`
      1.6.14 supports passkey-first signup** (`registration.requireSession:
      false` + `resolveUser`/`afterVerification`, client forwards `context`).
      This was the design's single biggest unknown and it resolved favourably;
      no custom endpoints needed.
- [x] 2026-08-07 — Design written (this doc).
- [x] 2026-08-07 — **Step 1 spike landed and green.** Passkey-first signup
      works end-to-end with no password. Also added Playwright (dev dep) +
      `e2e/` with a CDP virtual authenticator — the first real E2E harness in
      the repo, and the only way to regression-test passkey auth.
      `bun run typecheck`, `bun run test` (137 pass), and biome all green.
      Caveat: the WebAuthn ceremony is verified only against
      `http://localhost:17923`; **not yet exercised on a real HTTPS origin**.
- [x] 2026-08-08 — **DEPLOYED** (commit `08940c6`, "Deploy to firefly" green).
      `/_version` on `camptool.mathcamp.us` matches HEAD exactly. The
      `/spike/passkey` harness is **dev-only** — verified `HTTP 404` with no
      spike markers on production, both against a local production build over
      its unix socket and against the live site.
      Nothing about existing login flows changed; this is additive.
- [ ] Next: step 2 (schema + migration). No longer blocked — the domain
      question is answered.

### How to run the passkey tests

```
# terminal 1 — note the PUBLIC_BASE_URL override; rpID derives from it
PUBLIC_BASE_URL=http://localhost:17923 bun run dev

# terminal 2
bun run e2e:passkey        # full ceremony, runs under NODE (hangs under bun)

# the gate test wants its own throwaway DB + port, so it can flip the
# instance-wide invite-only switch without touching the shared dev DB:
DATABASE_PATH=./data/verify/passkey-gate.db PUBLIC_BASE_URL=http://localhost:17924 \
  PORT=17924 bun run dev
bun run e2e:passkey-gate
```
