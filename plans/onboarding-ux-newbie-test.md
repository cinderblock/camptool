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

Still open: **#6** (camp blurb on the application page — needs a camp
description field + officer-authored content), feedback-dialog shape, no
self-serve email/name edit for applicants.

## What worked well
- The three-field account creation is fast; no email-verification wall before applying.
- Two-step flow (account → short application) is low-friction; playa name optional.
- Re-visiting the `/c/` link gives correct state for both members ("You're already a
  member") and applicants ("You've already applied").
