# Every wizard step needs a home outside `/start`

## Goal

`/start` is a **wizard** — a guided first pass, not the place the data lives. Every
datum it collects must have a permanent, linkable home elsewhere, and every row on
the Overview "Your to-do" card must send the camper to that home rather than back
into the wizard.

Trigger: Cameron added people to his party on `/roster`, got the to-do *"Say where
the people with you are sleeping"*, clicked **Go**, and landed on `/start`. There is
nowhere else in the app to answer that question.

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\CampTool`, branch `master`.
- Dev port 17923. Live at `camptool.mathcamp.us`.
- The ask registry is `app/lib/asks.ts` (pure, client-safe) + `app/lib/asks.server.ts`
  (the snapshot queries). See `plans/outstanding-asks.md` for its design.
- The wizard is `app/routes/start.tsx`; its own catalog is `app/lib/wizard.ts`
  (still a second registry — Phase D of `plans/outstanding-asks.md` collapses it).

## The audit — what `/start` collects and where it lives

| Wizard step | Datum | Home before | Home after |
| --- | --- | --- | --- |
| `profile` | `user.name`, `membership.playa_name` | `/account` (IdentityCard) — ask pointed at `/start` anyway | **`/account`** |
| `questionnaire` (questions part) | `question_answer` | `/questions` | `/questions` |
| `questionnaire` (RSVP part) | `attendee.status` | **nowhere** | **`/trip`** (new) |
| — | `attendee.arrival_date` / `departure_date` | **nowhere** | **`/trip`** (new) |
| — | `setup_pass` request | `/passes` (officer view + request) | `/trip` prompt + `/passes` |
| `bringing` | `map_object` | `/bringing` | `/bringing` |
| `sharing` | `map_object_occupant` | **nowhere** | **`/bringing`** (new section) |
| `extras` (questions part) | `question_answer` | `/questions` | `/questions` |
| `extras` (note part) | `attendee.note` | **nowhere** | **`/trip`** (new) |
| `checklist` | `onboarding_completion` | `/onboarding` | `/onboarding` |

Three real gaps: **RSVP + stay dates**, **the free-text note**, and **occupants**.

## Decisions already made (don't re-ask)

1. **A new core page `/trip` — "Your trip · YEAR".** RSVP, stay dates (with the
   Setup Access Pass prompt), and the free-text note. It is *core*, not
   feature-gated: the `rsvp` and `stay_dates` asks carry no `feature`, and an ask
   must never link to a page that would bounce the camper
   (`requireFeature` redirects to `/`). That rules out folding RSVP into `/roster`,
   which is gated on the `roster` feature.
2. **Occupants live on `/bringing`.** They hang off *your* structures, which is
   what that page is; the `sharing` ask is already gated on the `bringing`
   feature, so the route matches the gate. Not a new page.
3. **The wizard posts to the real pages' actions.** Established pattern in
   `start.tsx` already (`BringingStep` → `action: "/bringing"`, `ChecklistStep` →
   `action: "/onboarding"`). So the `rsvp` / `requestSetupPass` intents move to
   `/trip` and `addOccupant` / `removeOccupant` move to `/bringing`, and `/start`
   submits there. One action per datum, no divergence.
4. **Shared UI is extracted, not duplicated.** `app/components/TripPlanner.tsx`
   holds the RSVP buttons, the stay calendar + pass prompt, and the note field;
   `/start` and `/trip` both render it.
5. **`extras` gets a real completion path.** It was satisfied only by walking the
   wizard (`acknowledged.extras`), which is exactly the resolution-not-satisfaction
   bug `plans/outstanding-asks.md` exists to kill. Now: satisfied by a non-empty
   `attendee.note` **or** an explicit "Nothing else to add" button on `/trip` that
   writes the acknowledgement.

## Plan / steps

- [x] Audit every `/start` step against where its datum lives (table above).
- [x] `app/components/TripPlanner.tsx` — extract `RsvpAndStay` + `TripNote`.
- [x] `app/routes/dashboard/trip.tsx` — the `/trip` page and the owning action.
- [x] `/start` submits RSVP / pass / occupant intents to the real routes.
- [x] `/bringing` — occupants section per domicile/vehicle + a "who still has no
      bed" callout.
- [x] `app/lib/asks.ts` — re-point `profile` → `/account`, `rsvp` + `stay_dates` +
      `extras` → `/trip`, `sharing` → `/bringing`. No ask routes to `/start`.
- [x] `hasNote` on `AskSnapshot` + `asks.server.ts`.
- [x] Nav: "Your trip" in the "Getting there" group.
- [x] Test: no ask may route to `/start` (guards the regression).
- [x] typecheck / lint / test green; driven in a real browser.
- [ ] Deployed — blocked, see below.

## Findings / gotchas

- **`/start` was the only writer of `attendee.status`.** `grep 'intent === "rsvp"'`
  hit `start.tsx` and `meetings.$occurrenceId.tsx` (a different, unrelated RSVP).
  So a camper could never change their mind about coming without re-entering the
  wizard.
- The `sharing` ask counts `partyWithoutBed` — hosted attendees with no
  `map_object_occupant` row *anywhere*, not just in the host's structures. The
  editor on `/bringing` (like the wizard step it replaces) only assigns people to
  the caller's own structures. Someone sleeping in another member's tent has to be
  added by that member. Left as-is; the callout names who is still unplaced so the
  gap is at least visible.
- `ParticipationStatus` lives in `wizard.server.ts`. The shared component can't
  import from a `.server` module, so `TripPlanner.tsx` exports its own copy of the
  union and `/trip` imports it from there.

### Deploy is blocked: `bun run build` OOMs on firefly

Pushed as `642a60d` (+ `704923f`). **Three consecutive `Deploy to firefly` runs
failed the same way, in `Build (Bun)`, before anything is staged or restarted:**

| Run | What happened |
| --- | --- |
| 32823766725 | client bundle ✓ 21s → SSR bundle `transforming…` 5½ min → `SIGKILL`, exit 137 |
| 32823766725 (re-run) | `The self-hosted runner lost communication with the server` |
| 32825947347 | client bundle ✓ → SSR `transforming…` **10 min** → `SIGKILL`, exit 137 |

`error: Failed to run "react-router" due to signal SIGKILL` /
`645521 Killed  bun run build` — the OOM killer.

**It is not the commit.** The same build at that exact SHA takes **17s wall,
3.8s for the SSR bundle** on this workstation, and the change adds two modules
to a graph of hundreds. Deploys on 2026-08-23 completed end-to-end in 1m00s.

**The build appears to be starving the whole box.** During the failing window,
both firefly-served hosts stopped answering while a non-firefly one was fine —
and both recovered once the build was killed:

    during                       after
    camptool.mathcamp.us  timeout    HTTP 200 (serving c119cd5, the OLD release)
    i.mathcamp.us         timeout    HTTP 200
    mathcamp.us           HTTP 200   HTTP 200

So production is **up and unharmed** — it's still on the previous release,
because the deploy never got past the build step. Nothing was rolled back and
nothing on the host was touched: infrastructure needs per-change authorization
from Cameron, and knocking the site over a fourth time to learn the same thing
isn't worth it.

Likely fixes, for whoever has the authority to make them: give firefly more RAM
or swap, cap the build (`NODE_OPTIONS=--max-old-space-size=…` won't bind Bun —
a `systemd-run --scope -p MemoryMax=` around the build step would), or build
the release elsewhere (a GitHub-hosted runner) and ship the artifact to firefly,
which also stops a deploy from being able to take the live site down.

## Things not to do

- **Don't** point an ask at `/start`. That's the whole defect. There's a test now.
- **Don't** gate `/trip` behind a camp feature — see decision 1.
- **Don't** leave a second copy of the RSVP write path in `start.tsx`.

## Progress log

- [x] 2026-08-25 — Audited, built and driven. `/trip` created, occupants moved
      onto `/bringing`, all five `/start`-routed asks re-pointed, wizard reduced
      to a view that posts into the real pages' actions.
