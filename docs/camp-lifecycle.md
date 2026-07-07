# Camp member lifecycle

How someone goes from "interested" to "on the playa" and back again next year.

This is a **design reference / source of truth for the model** — and the spec for
a future **in-app, member-visible onboarding overview** (see _Where this lives_
below). It is not the developer setup guide; that's the root [`README.md`](../README.md).

```mermaid
flowchart TD
    %% ---------- 1 · ways to join ----------
    subgraph JOIN["1 · Ways to join"]
        direction TB
        FOUND["Found the camp<br/>first account becomes admin"]
        APPLY["Public apply page · /c/:slug<br/>includes the camp's<br/>application questions"]
        INVITE["Friend invite link<br/>/i/:token"]
        ADD["An officer adds you"]
    end

    APPLY --> REVIEW{"Officer reviews<br/>your application"}
    REVIEW -->|accept| RECRUIT["Recruit"]
    REVIEW -->|waitlist| WAIT["Waitlisted"]
    WAIT -.->|revisited| REVIEW
    REVIEW -->|reject| REJECT["Rejected"]
    INVITE -->|redeem token| RECRUIT
    ADD --> RECRUIT
    FOUND --> ADMIN["Admin"]
    RECRUIT -->|officer promotes you| MEMBER["Member"]

    %% ---------- 2 · the season ----------
    RECRUIT --> WIZ
    MEMBER --> WIZ
    subgraph SEASON["2 · Getting ready — per year; the wizard pushes only what's relevant now"]
        direction TB
        WIZ["Onboarding wizard · /start"]
        WIZ --> RSVP["RSVP — coming this year?"]
        WIZ --> QN["Answer the questionnaire<br/>recruits get a longer set"]
        WIZ --> BRING["Declare what you're bringing<br/>tents, vehicles, shade…"]
        WIZ --> TICKETS["Request DGS tickets"]
        WIZ --> PASSES["Request setup-access passes"]

        BRING --> PLACE["An officer places it on the lot map"]
        PLACE --> TWEAK["You nudge your own spot → pending"]
        TWEAK --> APPROVE{"Officer approves?"}
        APPROVE -->|approve| ONMAP["On the map"]
        APPROVE -->|revert| PLACE
        TICKETS --> ASSIGN["Officer assigns a ticket"] --> PAID["Paid"]
        PASSES --> GRANT["Officer grants — quota-limited"]

        PROGRESS["Onboarding progress<br/>auto-derived, no manual ticking:<br/>RSVP'd · questionnaire done · ticket paid · placed"]
        RSVP -.-> PROGRESS
        QN -.-> PROGRESS
        PAID -.-> PROGRESS
        ONMAP -.-> PROGRESS
    end

    %% ---------- 3 · next year ----------
    SEASON --> BURN(["The burn — event week"])
    BURN --> NEXTYEAR["New year / edition<br/>copy from last year, then lock the old one"]
    NEXTYEAR -->|identity + role carry over · per-year data resets| WIZ
```

## The three concepts (and how they relate)

- **The wizard (`/start`) is the single member-facing driver.** It's season-aware:
  it surfaces only the asks that are in-season and relevant to this person right
  now (RSVP early, bringing/sharing as the event nears, etc.). Members rarely need
  the individual dashboard pages — those are the "advanced" way to do the same
  things. **Every join door converges here** — however someone got in, the wizard
  is what makes sure the important questions get answered.
- **Questions = one question bank, asked wherever it's needed.** Officers
  _author_ the questionnaire on `/questions` (typed questions: text, yes/no,
  choice, date…); campers _answer_ it through the wizard — and, for
  application-surfaced questions, already on the public apply form. See
  _The question axes_ below.
- **Onboarding = auto-derived progress, not a manual checklist** _(target model)_.
  Each item flips to done when its real condition is met — an admin marks a ticket
  paid → the "ticket" item checks itself; you RSVP → the "RSVP" item checks itself.
  It's a read-out of state, not a separate to-do list to tick by hand.
- **Editions = the year loop.** Identity and camp role carry over; per-year data
  (RSVP, answers, bringing, tickets, passes, placement) resets each new edition.

## The question axes — who gets asked what, where, and how often

Every question an officer defines on `/questions` carries four independent
switches; together they replace any hardcoded intake forms:

| Axis | Values | What it means |
|---|---|---|
| **Audience** | everyone / returning / recruit | Who sees it. Recruits get the bigger questionnaire; once promoted to member they stop seeing recruit-only questions. |
| **Scope** | every year / **once ever** | Per-year answers (rideshare, arrival, consent) reset each edition. `once` = a lifetime fact (previous camps, "how did you find us"): stored edition-less, pre-filled every later year, never re-asked once answered. |
| **Surface** | wizard / apply form / both | Where it's asked. Apply-form answers are collected pre-membership (held as JSON on the application) and **imported into the question bank** automatically once the person has a membership — so cold applicants and invite-link recruits end up with identical data, and nobody is asked twice. |
| **Placement** | before / after "Bringing" | Which wizard step it appears on. |

Plus **Required**: a required question blocks its wizard step's Next/Skip (and
the apply form's submit) until answered — enforced server-side too. This, with
the "Finish setup" pending-asks badge, is the guarantee that important
questions get answered no matter which door someone came through. A locked
(past) year is exempt — answers there are read-only.

### How the two doors flow into one record

1. **Cold applicant** (`/c/:slug`): answers the application-surfaced questions
   on the form → held on `recruit_application.answers` (no membership yet) →
   officer reviews with those answers visible on `/recruits` → on acceptance
   (and first wizard/questions visit) the answers import into
   `question_answer`, skipping anything they've since re-answered.
2. **Invite-link recruit** (`/i/:token`): joins instantly with no form — the
   wizard asks them everything wizard-surfaced for the recruit audience,
   including the `both`-surfaced questions cold applicants answered at the door.

## Where this lives (intent)

The end goal is to surface this lifecycle **in the app, visible to members** — a
"how camp works / where am I in the process" view that doubles as the onboarding
overview — rather than living only in this doc. This document is the spec for that
feature; the diagram above is what it should communicate.

## Status vs. target

- **Built today:** all four join paths; the season-aware wizard; questionnaire
  authoring + answering with all four question axes (audience, scope, surface,
  placement) + required-question enforcement; application answers importing
  into the question bank on membership; bringing → place → pending-approval;
  ticket request → assign → paid; pass request → grant; per-year editions with
  copy-from + lock.
- **Target (not yet built):** onboarding progress **auto-derived** from state
  (currently the checklist is ticked manually); the **member-visible in-app**
  rendering of this whole flow.
