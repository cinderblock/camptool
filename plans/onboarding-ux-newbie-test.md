# Onboarding UX walkthrough — "new to Burning Man" persona test

**Date:** 2026-07-04
**Method:** Live site (camptool.mathcamp.us), fresh incognito session, entered via the
public application link `/c/math-camp-group-w-m0d3`. Persona: "Claude Fable," a
first-time burner who found the camp randomly online.

**Test accounts left in place** (delete when done; both use password `playa-dust-Fable-2026!`):
- Claude Fable · `claude-fable@example.com` — has a pending application in the
  Recruits queue (playa name blank, "never been to Burning Man" message).
- Claude Fable Two · `claude-fable-2@example.com` — account only, NO application
  (created post-fix to verify the apply form's checkbox reveal live).

## Findings, ordered by severity

### 1. Post-application dashboard says "No camp yet" — looks like the application vanished
After applying, visiting the site root as the logged-in applicant shows **"No camp yet —
New camp creation is currently turned off on this deployment. Ask a site administrator to
create your camp or to re-enable camp creation."**
- Zero acknowledgment of the pending application. A newbie reads this as "my application
  was lost" or "I'm in the wrong place."
- The copy is aimed at a would-be camp *creator*, not an *applicant* — worst possible
  message for this audience.
- Fix idea: dashboard for a user with a pending application should show "Your application
  to Math Camp @ Group W is pending — the camp will reach out" + link back to `/c/<slug>`.

### 2. Applicant sees the full member nav, and every link silently bounces
Sidebar shows Members / Years / Map / Bringing / Supplies / Documents / Tickets / Passes /
Questions / Onboarding / How it works. Every one redirects back to `/` ("No camp yet"),
with no message. Feels broken — clicking does *nothing* visible (active item stays
"Overview"). Either hide camp-scoped nav for camp-less users or show "you'll get access
once accepted."

### 3. Application status only lives at the original `/c/` link
Signup copy promises the account "lets you … check on your application later," but the
only status surface is re-visiting the original invite URL (shows "You've already applied —
the camp will be in touch. Hang tight!"). Nothing in the app links there. If the applicant
loses the link (e.g. applied from a phone at a party), there's no path to status.

### 4. The confirmation screen is a dead end
"Thanks, Claude Fable! Your application is in." — no next steps: no "we'll email you at
<address>," no "learn more about the camp meanwhile," no link to anything. Also, since
there's no email verification, a typo'd email silently breaks "the camp will reach out."

### 5. Jargon: "Playa name" with no explanation for outsiders
Field help is "Optional — what folks call you on playa" — meaningless to someone who's
never been. One more clause fixes it, e.g. "the nickname burners go by at the event —
skip it if you don't have one (most first-timers don't)."

### 6. The application page says nothing about the camp
The entire pitch is "Math Camp @ Group W — Interested in joining? Tell us a bit about
yourself and the camp will reach out." For someone arriving cold there's no what/where/
when/cost/expectations, no link to a camp blurb, and "Group W" reads as insider humor.
You're asked to create an account before learning anything. Even one paragraph + a link
would help conversion and self-selection.

### 7. Smaller nits
- Signup card copy: "Create an account to apply — it lets you set a password…" but the
  form right below already has a Password field; "set a password" reads redundant/confusing.
- No password requirements shown on signup (didn't probe the actual policy).
- "Continue with a passkey" as the alternative on the *create account* tab may baffle
  non-technical folks; fine to keep, but it's the only alternative offered (no Discord
  here, though members use it — probably intentional for strangers).
- Feedback dialog is strictly bug-report-shaped (What were you doing / try / expect /
  actually happened) even when Type is not obviously "question"; an applicant wanting to
  ask "what's my status?" has no fitting channel. Also the dialog opened stacked on top of
  the still-open user menu once (minor z/focus management nit).
- User menu contains only the email + Sign out — no account settings; an applicant can't
  fix a typo'd name/email after submitting.

## Fixes landed (2026-07-04, same session)

- **#1 + #3:** camp-less dashboard now queries pending `recruit_application`s
  (by userId or email) and shows an "Application pending" card per camp with the
  camp name, the email the camp will use, and a link back to `/c/<slug>`
  (`dashboard/index.tsx`, `CreateCamp` → `NoCampYet`).
- **#2:** sidebar nav hides all camp-scoped items for camp-less users — just
  Overview (+ Site admin for superadmins) (`dashboard/layout.tsx`).
- **#4:** post-apply confirmation (and the returning "already applied" state) now
  says the camp will reach out at `<email>` and that this page shows status
  (`c.$slug.tsx`).
- **#5:** playa name is hidden behind an "I've been to Burning Man before"
  checkbox (per Cameron — don't surface it to first-timers at all); when shown,
  the description explains it plainly. BM wording flagged as event-layer copy.
- **#7 (partial):** signup intro no longer says "set a password" above a
  password field — now "so you can sign back in later and check on your
  application."

All of the above **verified live** on camptool.mathcamp.us (commit `4619635`,
deploy green): pending-application dashboard + trimmed nav as Claude Fable;
apply-form checkbox reveal + new signup copy as Claude Fable Two.

Second pass (same day, per Cameron's "do it") — the remaining three:

- **#6 camp blurb:** new `camp.description` column (migration **0041**, additive
  ALTER, generated with the other thread's in-flight `flag.ts` export transiently
  disabled so the migration contains ONLY this column). Shown on `/c/:slug`
  above the apply card (plain text, newlines kept). Officers edit it on
  `/recruits` in the Public application link card ("Public page blurb" textarea,
  `saveDescription` intent). CONTENT IS STILL EMPTY — Cameron: write the blurb
  in /recruits.
- **Feedback question:** added a `question` kind (client + server); non-bug
  kinds already had a freeform body, so a question now gets "Your question"
  instead of the bug template.
- **Contact self-serve:** pending-application dashboard gains a "Your contact
  details" card (name + email, `updateContact` action). Action is applicant-only
  (403 with a camp), validates + checks email uniqueness, resets emailVerified
  on change, and syncs the user's PENDING recruit_application rows so officers
  see the fix.

Still open: none from the original walkthrough. (Nit not pursued: feedback
dialog stacking over the user menu.)

## Invited-flow walkthrough (2026-07-04, per Cameron)

Generated a fresh invite link from Cameron's session (`/invite`), redeemed it in
incognito as **Claude Fable III** (`claude-fable-3@example.com`, same password) —
full path: invite page → account create → explicit "Join" button → straight into
the `/start` wizard → completed all 6 steps ("You're all set!"). Fable III is now
a **recruit member** of the live camp (remove from Members when done). Cameron's
invite link `79s86I0vVGWM5AYsJ_zMpdPvGHNfRwFB` has 1 use — revoke at will.

Findings:
- **Arrival picker was the broken DateInput** Blake reported (giant chevrons,
  cramped grid) — the participation ask never got EventCalendar (the D4 debt).
- **FIXED same session (migration 0042):** arrival + the separate "stay until
  (strike)" question are now ONE booking-style range on `EventCalendar` (tap
  arrival, tap last day, green stay band, nights count). `participation` gained
  `departure_date`; `StayAsk` replaces `ArrivalAsk` in `start.tsx`.
  **Cameron admin task:** delete the now-redundant "Which day can you stay until
  (strike)?" question in /questions.
- ~~Invite page (`/i/:token`) doesn't show the camp blurb and still has the old
  "set a password" copy~~ — FIXED in the DRY pass below.
- ~~Wizard "Your info" step surfaces playa name to everyone~~ — FIXED (shared
  `PlayaNameField`).
- "How did you first hear / who invited you?" is a plain textarea even though
  the invite records the inviter — the camp question isn't typed `invited_by`
  (admin config, pairs with the B4 dropdown work).
- Autosize textareas + conditional reveals ("I'm coming" → stay picker) shift
  the layout while filling — mildly disorienting, no data loss.
- ~~"Skip / do it manually" link wording is unclear to a newbie~~ — FIXED
  ("Skip for now").

## DRY / placement pass (2026-07-05, per Cameron)

- **`app/components/PlayaNameField.tsx`** — the been-to-BM checkbox + revealed
  playa-name input, shared by the `/c/` apply form and the wizard's profile
  step (pre-checked when a playa name already exists).
- **`app/components/CampHero.tsx`** — logo/name/blurb/tagline header shared by
  `/c/:slug` and `/i/:token`; the invite page now shows the camp blurb too.
- **`app/lib/recruits.server.ts`** — `isMemberOf(userId, campId)` and
  `pendingApplicationWhere(viewer, campId?)`; replaced four hand-rolled
  membership checks (`c.$slug` ×2, `i.$token` ×2, `recruits.tsx` accept) and
  three pending-application conditions (`c.$slug` ×2, dashboard ×2).
  NOT touched: the same membership check in `members.tsx` — another thread has
  uncommitted work there.
- Invite-page copy now matches `/c/` ("so you can sign back in later").

## Invite kind locked (2026-07-05, per Cameron)

`camp_invite.kind` ('personal' | 'open', migration **0043** with backfill:
existing `max_uses IS NULL` rows → 'open'). The kind is set at creation and
never mutated: **personal** = tied to its inviter, maxUses forced to 1,
redeemer's membership records `invited_by`; **open** (officer-only) = camp
door, reusable, joining records NO personal inviter and the /i/ page says
"You're invited to join X" instead of naming the creator. /invite list shows
a Type badge.

Backfill nuance: ALL five pre-existing links — including the `79s86…` one used
for the Fable III walkthrough — were created under the pre-one-time code
(`max_uses` NULL, unlimited), so the backfill correctly classed every one of
them as **open**; no personal links exist yet. Live-verified: open links now
show the nameless "You're invited to join…" tagline. The personal path (named
inviter + invited-by edge) only runs for one-time links minted under the new
code. Cameron: revoke the stale unlimited links (79s86 included) and mint
fresh one-time links per friend.

## Joining flowchart (2026-07-05, per Cameron)

**Decision: lives on `/guide` ("How it works")** as the visual centerpiece —
that page already narrates joining→playa→next-year. Built as a standalone
`app/components/JoinFlowchart.tsx` (pure Mantine/CSS, no chart dep, themes
with the app) so it can later drop onto a public page. Shape: two entry doors
(friend's invite · found us online) → merge → Onboarding → Get ready for
{year} → Go to Burning Man → You're in the camp, with a dashed "next year ↺"
rail looping back to Get ready. Old phase cards kept below as "The details".
"Go to Burning Man" is event-layer copy (flagged in the component).
- Good: inviter name on the invite page, explicit Join consent, tent size
  prompt, EventCalendar with Gates/Burn/Temple/Exodus callouts, "answers save
  as you go", clean "You're all set!" finish.

## What worked well
- The three-field account creation is fast; no email-verification wall before applying.
- Two-step flow (account → short application) is low-friction; playa name optional.
- Re-visiting the `/c/` link gives correct state for both members ("You're already a
  member") and applicants ("You've already applied").
