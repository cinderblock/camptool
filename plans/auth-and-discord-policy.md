# Auth providers + per-camp Discord policy (design, 2026-07-16)

> Plan path: `plans/auth-and-discord-policy.md`
> Parent plan: `plans/camptool.md`. Related: `plans/whos-coming-attendees.md`
> (invitation dead-end finding), `docs/discord-setup.md`, `docs/camp-lifecycle.md`.

## Goal

Two user asks, one design:

1. **More OAuth providers** ("a bunch of backends") — Google, GitHub, Apple, …
   alongside Discord + email/password + magic link + passkeys.
2. **Per-camp Discord policy** — some camps allow any auth; some camps want to
   "force Discord" so every camper is reachable on Discord as an alternate
   comms channel.

## The key distinction (locks the whole design)

**Auth method is account-scoped; Discord reachability is camp-scoped.**

- A user account is instance-level and can belong to MULTIPLE camps (the
  multi-camp invariant). Camp A can't dictate how someone logs in without
  breaking their membership in Camp B. "Force Discord login" is therefore the
  wrong lever — and unnecessary.
- What a Discord-first camp actually needs is: *every member has a linked
  Discord account that is in THIS camp's guild*. That's a **membership
  requirement**, not an auth requirement. Someone can log in with a passkey
  forever and still satisfy it.
- The schema already models this: `discord_link` is (camp_id, user_id) unique
  with `inGuild` + `verifiedAt` — "reachable in this camp's guild" is
  precisely what it records. The login credential lives separately in
  better-auth's `account` table.

So: **auth stays instance-wide and permissive; "Discord required" becomes a
per-camp policy over `discord_link`, not over login.**

## Design

### 1. OAuth provider expansion (instance-level)

- Each provider = a `socialProviders` entry in `auth.server.ts` gated on env
  vars, exactly like Discord today (`GOOGLE_CLIENT_ID/SECRET`, …). Absent env
  = provider absent. Buttons appear in `AuthInline`/login conditionally, like
  `discordEnabled` does now.
- **Account linking policy must be decided** (better-auth `accountLinking`):
  recommend link-by-verified-email so "applied with email/password, later
  clicked Sign in with Google" converges on one account instead of a
  duplicate.
- **Apple caveat:** private-relay emails break every email-matching flow
  (`/recruits` accept-by-email, application-answer import). Invite-LINK flows
  are immune — one more reason to land the recruits link fix (open question
  in whos-coming plan) before/with provider expansion.
- Callback URLs are per provider per deployment (localhost:17923 + prod) —
  document per provider like `docs/discord-setup.md`.
- Verify once per provider that the invite-only signup-unlock cookie survives
  the OAuth round-trip (Discord is the only provider that's exercised it).

### 2. Per-camp Discord policy (camp-level)

A camp setting — natural home is the existing **camp-features `/settings`
page** area, but this is a *policy*, not a feature toggle; suggest a column
on `camp` (or a small `camp_policy` concept if more policies follow):

    discordPolicy: 'off' | 'encouraged' | 'required'

Semantics (an enforcement ladder, not a wall):

- **off** — nothing changes.
- **encouraged** — the wizard gets a "Link your Discord" ask (season-aware
  catalog entry, skippable); members page keeps showing Not linked.
- **required** —
  - The join doors (apply page, invite pages) SAY it up front: "This camp
    uses Discord — you'll link your account during setup." (No hard wall at
    the door: don't bounce someone before they're even in; they may not have
    Discord installed at redeem time.)
  - The wizard "Link your Discord" ask becomes **required** — same machinery
    as required questions (blocks that step's Next/Skip; "Finish setup" stays
    pending until `discord_link.inGuild` is true for this camp).
  - Officers see who's unlinked (members page already shows "Not linked");
    optionally a roster/members filter.
  - Optional later step: gate recruit→member promotion on it.

Why the ladder instead of forcing Discord OAuth at signup: multi-camp
accounts (above), plus the goal is reachability — a linked+in-guild account
via any login achieves it; a Discord login without joining the camp's guild
does NOT. (`inGuild` is the real target, not the OAuth credential.)

### 3. Layering note (event/camp seams)

- `DISCORD_GUILD_ID` is currently ONE env var — instance-wide. True
  multi-camp Discord (each camp its own guild) needs the guild id to move to
  per-camp config (camp settings), with the bot invited per guild. Flag now,
  don't build until a second camp needs it.

## Open questions for the user

1. Which providers first? (Google is the obvious high-coverage one; Apple
   only if iOS-heavy campers demand it — it carries the relay-email caveat.)
2. `required` semantics: is wizard-blocking + pending-setup enough, or should
   any door hard-require a linked Discord before membership is created?
   (Recommendation: wizard-blocking; hard door walls lose recruits.)
3. Does "required" mean linked, or linked AND in-guild? (Recommendation:
   in-guild — reachability is the goal; the link page can deep-link the guild
   invite.)
4. Sequence: recruits invite-link fix → account-linking config → providers →
   discord policy? (Recommended order.)

## Progress log

- [x] 2026-07-16 — design written (this doc), grounded in existing
      `discord_link` schema (already camp-scoped with `inGuild`). No code.
