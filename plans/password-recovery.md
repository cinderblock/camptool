# Password recovery without email (design + build plan, 2026-08-12)

> Plan path: `plans/password-recovery.md`
> Parent plan: `plans/camptool.md`. Sibling: `plans/passkey-first-auth.md` —
> this is the *password* half of the same recovery story, and it deliberately
> reuses that plan's Layer 5 shape (officer-issued, camp-scoped, rank-checked).

## Goal

A campmate can't sign in. CampTool has **no mail transport** — `magicLink`
`console.log`s the URL (`app/lib/auth.server.ts:136-142`) — so better-auth's
built-in forget-password flow is unreachable. There is no "forgot password"
link anywhere in the app today, on purpose: it would be a dead end.

Two things to build:

1. **Officer-issued password reset link.** An officer generates a URL, copies
   it, and sends it to the person out-of-band (Signal, text, Discord DM). The
   officer accidentally opening it must be harmless and *informative*.
2. **Self-serve password management** on `/account`: change your password, and
   — if you have a passkey — **delete** it entirely.

Both keep pushing people toward passkeys. Passwords are a legacy credential
here; the set of accounts holding one should only ever shrink.

## Decisions already made (don't re-ask)

From Cameron, 2026-08-12:

1. **Passkey-only accounts do NOT get an "add a password" button.** The
   `/account` password card appears only for accounts that already have one,
   offering Change and Remove. This is what makes "the set of password-holders
   only ever shrinks" true. The officer reset link is the sole escape hatch
   that can *create* a password, and it is deliberately a break-glass path.
2. **Removing your password requires ≥1 enrolled passkey.** Not Discord (it can
   be revoked upstream by a party we don't control), not magic link (needs the
   mail transport that doesn't exist). The guarantee is that a *working*
   credential remains.
3. **Reset links live 7 days.** Long enough that a campmate who reads the DM on
   the weekend can still use it; short enough that a stale link in a chat log
   dies.

Implied by the ask, and worth writing down:

4. **Issuing a link does not touch the existing password.** Nothing changes
   until someone completes the reset. A leaked-but-unused link is not a
   lockout.
5. **The link alone is not sufficient.** Redeeming requires typing the email
   address the link was issued for. The link is *something you have*; the email
   is *something you know*. That is what makes "the admin accidentally opened
   it" a non-event.

## Design

### The token

192 bits of `crypto.getRandomValues`, base64url, in the path: `/reset/:token`.
**Stored as a SHA-256 hash**, never in plaintext — a bearer credential that can
set a password is worth more than an invite token, so this does *not* follow
`camp_invite`'s store-it-raw pattern (`db/schema/recruit.ts:59`). Lookup hashes
the presented token and matches on `token_hash`.

### The table — `password_reset` (new, `db/schema/recovery.ts`)

Camp-scoped, mirroring `plans/passkey-first-auth.md` Layer 5:

| Column | Note |
|---|---|
| `id` | |
| `camp_id` | FK camp, cascade. Which camp's officer issued it. |
| `user_id` | FK user, cascade. Whose password it resets. |
| `issued_by_membership_id` | FK membership, **set null** — the audit trail must survive the officer leaving. |
| `token_hash` | unique; SHA-256 hex of the URL token. |
| `expires_at` | issue + 7d. |
| `used_at` | set on successful reset; the link is then spent. |
| `revoked_at` | set when the officer issues a *newer* link for the same person. |
| `attempts` | wrong-email guesses. At 5 the link is dead. |
| `created_at` | |

Rows are **kept after use** — they are the audit log of who reset whom.

**Why camp-scoped when a password is account-scoped?** Same reason
`passkey_reset` is: the *authorization to issue* is camp-scoped (officer of
this camp, strictly outranking the target). The credential it resets is
account-wide, and that asymmetry is inherent to the multi-camp decision — see
`plans/passkey-first-auth.md` §"The constraint that shapes everything".

### Issuing (members page, officer+)

A **Reset password** button in the same row-action group as Work as / Remove /
Merge, under the existing `editable` gate — so it inherits `canManage &&
!isSelf && rankOf(actor) > rankOf(target)`. Rank is **re-checked server-side**;
the UI gate is not the authorization.

Issuing **revokes any earlier live link** for the same (camp, user), so there
is never a pile of live links for one person and no separate revoke UI is
needed.

The URL comes back in the fetcher response and is shown in a modal with a
read-only field + Copy button, plus the expiry date (ISO) and a note about
whether the target currently has a password at all.

The members table also grows a **Sign-in** column (officer-only): passkey ✓ /
password ✓ per member. That is the thing an officer actually needs in order to
answer "why can't they log in", and it doubles as
`plans/passkey-first-auth.md` step 8's adoption column.

### Redeeming — `/reset/:token` (public, no auth)

**A passkey is the primary path.** The link's main button enrols a passkey;
the password form is collapsed behind "my device can't do passkeys". This is
the point of the whole feature — the one moment a locked-out member is
guaranteed to be paying attention is the moment to hand them the credential we
want them on, not another password to forget.

How it works without a session (they can't sign in — that's the premise):

1. They type the email; `POST /api/passkey-recovery` checks link + email and
   returns an opaque handle.
2. `addPasskey({ context: handle })` runs the WebAuthn ceremony. The plugin's
   `registration.resolveUser` fires **only when there is no session** and may
   point the ceremony at any user id — so it attaches to the existing account.
   Same mechanism as password-free signup (`passkey-signup.server.ts`); this is
   the second consumer of it.
3. `afterVerification` spends the link and drops the account's old sessions.
4. `signIn.passkey()` turns the fresh credential into a session; land on
   `/account`.

**The recovery branch is checked BEFORE the invite-only gate** in `resolveUser`,
deliberately: it creates no account, so there is nothing for the lockdown to
guard, and gating it would lock a camp's own members out of an invite-only
deployment — exactly backwards.

**Existing passkeys are NOT revoked** on recovery, deviating from
`plans/passkey-first-auth.md` Layer 5. That plan assumed a reset implies the old
authenticator is compromised; neither we nor the officer can know that, and
someone recovering onto a second device would be unpleasantly surprised to find
their first one wiped. Sessions still go. They can remove old credentials on
`/account`, where they can see what they're removing.

Both paths run through the same `verifyResetEmail`, so the passkey route is
exactly as hard to reach as the password route — a weaker door onto the same
account is the one attackers would use.


**Loader always shows status, never consumes.** States:

- `valid` — with the ISO expiry, the issuing camp's name, and a **masked**
  email (`ci•••••@g•••.com`) so the recipient can tell it's for them.
- `expired` / `used` / `revoked` / `locked` (too many wrong-email attempts) /
  `unknown` — each with copy telling the reader to ask an officer for a new
  link.

This is the "if the admin accidentally opens it" requirement: opening is a pure
read. Nothing is consumed, nothing is invalidated, no password changes.

**Action** takes email + new password + confirm:

- Email must match the target's, case- and whitespace-insensitively. A mismatch
  increments `attempts` and reports how many remain. At 5 the link is `locked`.
- Password is validated against better-auth's own configured bounds
  (`ctx.password.config.minPasswordLength` / `max`), read from the auth context
  so it can't drift from `emailAndPassword.minPasswordLength`.
- On success: hash via `ctx.password.hash`, upsert the `credential` account
  row, **delete all the user's sessions**, mark `used_at`, redirect to
  `/login?reset=1`.

The set-password step mirrors better-auth's own `/reset-password` handler
(`node_modules/better-auth/dist/api/routes/password.mjs:150-165`) — same
create-account-if-missing-else-update-password logic — rather than minting a
fake `reset-password:` verification row just to call the endpoint.

**Why revoke sessions?** The realistic reasons someone needs this link are "I
forgot it" and "I think someone else has it". The second one makes revocation
mandatory and the first makes it harmless (they have none).

### Self-serve — `/account` password card

Rendered **only when the account already has a `credential` row** (decision 1).

- **Change password** — current + new + confirm, via
  `auth.api.changePassword({ revokeOtherSessions: true })`. Uses the real
  session cookie, so it is server-enforced.
- **Remove password** — enabled only with ≥1 passkey (decision 2), re-checked
  server-side. Deletes the `credential` account row. Copy explains *why* you'd
  want to: a password is the part of your account that can be phished, guessed,
  or leaked in someone else's breach; a passkey can't be.

**Impersonation is blocked for both.** `auth.api.changePassword` authenticates
off the request's real session cookie, so an officer "working as" a member
would change *their own* password while the UI showed the member's name. Every
password mutation on `/account` refuses when `impersonatedBy` is set. This is a
real footgun, not a hypothetical — the same shape bit `resolveActiveCamp`'s
privacy guard.

## Findings / gotchas

These each cost real time; none are guessable from the docs.

1. **better-auth hashes with scrypt, not SHA-256.** `hashPassword` comes from
   `@better-auth/utils/password`
   (`node_modules/better-auth/dist/crypto/password.mjs:1-9`) and produces a
   salted scrypt value. An earlier abandoned attempt at this feature hand-rolled
   `crypto.subtle.digest("SHA-256", …)` and wrote the hex into
   `account.password`. That *looks* fine — the action returns 200, the row
   updates — but `verifyPassword` can never match it, so the reset silently
   produces an account nobody can sign into. **Always go through
   `ctx.password.hash` / `auth.api.changePassword`.** Test #8 in
   `e2e/password-reset.ts` exists specifically to catch this class of bug: it
   asserts the new password actually *signs in*, not that the request succeeded.

2. **`data(value, { headers })` does NOT deliver a `Set-Cookie` to the browser**
   in React Router v7 here — verified by inspecting `getSetCookie()` on the raw
   response: zero cookies. `redirect(url, { headers })` does. This matters
   because `changePassword({ revokeOtherSessions: true })` **rotates the
   caller's own session token** (`update-user.mjs:170-179` deletes all sessions,
   creates a fresh one, sets the cookie). Swallow that cookie and the user is
   holding a token that no longer exists — they get bounced to `/login` the
   instant they successfully change their password. So the success path
   redirects to `/account?changed=1` carrying the cookie, and the confirmation
   banner is driven off the search param rather than `fetcher.data`.

3. **`auth.api.*({ returnHeaders: true })` returns `{ headers, response }`** and
   is the only way to get at better-auth's `Set-Cookie` from a server action.

4. **Mantine `Badge` truncates in a narrow table column.** Its label is
   `overflow:hidden; text-overflow:ellipsis`, so in the ~56px the table gave the
   Sign-in column both badges collapsed to `N…` / `PA…` — unreadable, and no
   amount of `nowrap`/`flexShrink` on the cell fixed it. Plain `<Text size="xs">`
   does not truncate; use that in tight columns.

5. **A JSX comment cannot sit beside an element inside a ternary branch.**
   `{cond ? ( {/* … */} <Td/> ) : null}` is a syntax error (two expressions);
   the comment has to go outside the `?`.

6. **Passphrases already work; only the wording implied otherwise.** The value
   is never trimmed anywhere in the flow and the only bound is better-auth's
   128 characters, so spaces, punctuation and non-ASCII all round-trip intact —
   verified for four-word phrases, emoji and a 110-char string. The fields are
   labelled "New password or passphrase" with a nudge, because people assume
   "password" means one short mangled word.

   **Do not add `.trim()` to any password field.** A passphrase typed with a
   trailing space would be *stored* trimmed but *typed* untrimmed at sign-in,
   locking the person out with no error that explains why. Test 18 in
   `e2e/password-reset.ts` pins this.

7. **React escapes apostrophes in SSR output** (`isn't` → `isn&#x27;t`), so
   asserting on copy containing `'` silently never matches. Match on
   apostrophe-free substrings in E2E tests.

## Things not to do

- **Don't add a "forgot password?" *button* to `/login`.** It has nowhere to go
  until a mail transport exists. The officer-issued link *is* the recovery path,
  and it's delivered by a human on purpose. Saying so in words is different from
  offering a control — see the `mailEnabled` note below; the pages now *explain*
  the situation, they still offer nothing that mails anything.
- **Don't let the reset link change the email address.** It proves you know the
  email; it does not grant you authority over it.
- **Don't store the token in plaintext**, and don't log the full URL
  server-side.
- **Don't let an officer reset someone who outranks them** — same
  privilege-escalation hole as passkey reset.
- **Don't consume or invalidate the link on GET.** The whole "admin opens it by
  accident" requirement dies if the status page has side effects.
- **Don't offer "add a password" to passkey-only accounts** (decision 1).

## Progress log

- [x] 2026-08-12 — Audited the auth layer; confirmed in `node_modules` that
      `ctx.password.hash` / `.config`, `internalAdapter.updatePassword` /
      `createAccount` / `deleteUserSessions`, and `auth.api.changePassword`
      all exist in better-auth 1.6.14 and are usable server-side.
- [x] 2026-08-12 — Three decisions locked with Cameron (no add-password,
      passkey-required removal, 7-day TTL).
- [x] 2026-08-12 — Design written (this doc).
- [x] 2026-08-12 — `password_reset` table + migration.
- [x] 2026-08-12 — `app/lib/password-reset.server.ts` (issue / inspect /
      redeem / mask) + unit tests.
- [x] 2026-08-12 — `/reset/:token` status + redeem route.
- [x] 2026-08-12 — Members page: issue action, rank check, link modal,
      Sign-in column.
- [x] 2026-08-12 — `/account` password card: change + remove.
- [x] 2026-08-12 — **Consolidated onto one implementation.** An earlier,
      unfinished attempt at the same feature was sitting uncommitted in the tree
      (`app/lib/password.server.ts`, `app/routes/password-reset.$token.tsx`,
      a `password_reset_token` table + migration 0069, partial `/admin` and
      `/account` edits, `plans/password-reset-and-change.md`). It was removed
      rather than merged: its hashing was unusable (finding 1), its tokens were
      stored in plaintext with a 1h TTL, it had no email-match check, no rank
      check, and no status page. Its migration had never been applied (the dev
      DB was still at 0068), so removing it was clean; `password_reset` was
      regenerated as `0069_oval_preak.sql`. A safety snapshot of everything is
      in `git stash` as `pre-password-recovery-consolidation`.
- [x] 2026-08-12 — **Verified end-to-end. 32/32 in `e2e/password-reset.ts`**
      (`bun run e2e:password-reset` against a throwaway DB), covering: issue →
      read-only status page → wrong-email attempt burn → redeem → **the new
      password really signs in and the old one doesn't** → link reads as used →
      reissue revokes the previous → unknown token renders a status page; plus
      change-password (wrong current refused, session survives the rotation, old
      token dead) and remove-password refused server-side without a passkey.
      Both UI surfaces driven in a real browser: the members-page link modal
      (correct copy, ISO expiry, the URL) and the `/account` password card
      (Remove disabled with its inline reason). typecheck, 154 unit tests and
      biome all green.
- [x] 2026-08-14 — **Passkey enrolment is now the recovery link's primary
      action** (Cameron's actual ask; an earlier turn misread "passkey" as
      "passphrase"). New `app/lib/passkey-recovery.server.ts` +
      `POST /api/passkey-recovery`, wired into the passkey plugin's
      `resolveUser` / `afterVerification` ahead of the invite-only gate. The
      password form is demoted to an escape hatch, not removed. Verified with a
      CDP virtual authenticator in `e2e/passkey-recovery.ts` — **11/11**,
      including that a wrong email is refused *before* any ceremony, that the
      link is spent afterwards, and that the new passkey signs in on its own
      from a cleared browser session. `e2e/password-reset.ts` 36/36 and
      `e2e:passkey` (signup) still green after the `auth.server.ts` change.
- [x] 2026-08-18 — **The public pages now say there is no email.** The one
      email-delivered affordance still on a logged-out page was "Email me a
      magic link instead", on `/login` and (via `AuthInline`) on the public
      apply page `/c/:slug` and the invite page `/i/:token`. With no transport
      it produced a "Magic link sent — check your email" toast for a message
      that never arrives, which is strictly worse than no button: the person
      waits instead of asking a human. Added `mailEnabled` (a plain constant in
      `app/lib/auth.server.ts`, deliberately **not** env-driven — an env var
      would let a self-hoster switch the buttons on without wiring delivery,
      which is the exact failure being guarded). While it's false, all three
      pages render `NoMailRecoveryNote` in that slot instead: *"Forgot your
      password? This site doesn't send email, so there's no automatic reset. Ask
      an officer of your camp to generate a recovery link for you — that's how
      you get back in."* Flip the constant in the same change that implements
      real sending and the magic-link affordance comes back everywhere at once.
      Verified rendered on `/login` and `/c/:slug`; typecheck, biome, 235 unit
      tests and `e2e:passkey-nag` (which drives the `/login` tabs) all green.
      Unrelated pre-existing breakage fixed in passing: `e2e:passkey-nag`'s
      `getByRole("button", {name: "Remove"})` had become a strict-mode violation
      when `/account` grew a "Remove password" button; it needs `exact: true`.
- [ ] Next: deploy, then tell the campmate to expect a link.
