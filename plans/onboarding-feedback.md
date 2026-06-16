# Onboarding wizard feedback — Blake & Andrew run-through

> Plan path: `plans/onboarding-feedback.md`
> Source: recorded transcript of Cameron + Blake (`transcript-269cd652b6b3.txt`,
> 2026-06-16) walking the `/start` wizard as a new recruit, plus notes from an
> earlier Andrew run-through. Parent plan: `plans/camptool.md`.

## Goal

Turn the recorded onboarding feedback into concrete changes & bug fixes to the
camper-facing wizard (`/start`) and a couple of map/overview items. Keep the
wizard cleaner and less confusing for a brand-new recruit.

## Environment

- Wizard: `app/routes/start.tsx` (Mantine `Stepper`, one `AskBody` per step).
- Ask catalog/scheduler: `app/lib/wizard.ts` (`ASKS`, `AskKey`).
- Question field renderer: `app/components/QuestionField.tsx` (incl. the buggy
  `event_date` `DateInput`).
- Structure palette: `app/lib/structures.tsx` (`KINDS`).
- Map editor: `app/routes/dashboard/map.tsx` (`canEdit = hasAtLeast(role,
  "member") && !locked`; per-object `canDrag = canManage || (canEdit && own)`).

## Feedback items (triaged)

### Clear code fixes (low ambiguity)
1. **Stepper is confusing** — the horizontal 1–6 step header wraps weirdly on wide
   screens (6 on a different line than 1), and a new user doesn't realize the
   content below belongs to the *current* step. Blake's ask: vertical numbered
   list with the section collapsing as you advance.
   → Switch Mantine `Stepper` to `orientation="vertical"` (renders each step's
   body inline beneath its label; only the active step's body shows). Andrew hit
   the same thing.
2. **Tickets step not needed in the wizard** — "that links tickets section you
   don't need." → Remove the `tickets` ask from `ASKS` (keep the /tickets page).
3. **Container = shipping container** — a camper shouldn't be able to declare a
   40ft shipping container (or generator/kitchen/spiderbox/communal shade/art) in
   the Bringing step. → Camper-facing palette = personal subset only (domiciles +
   personal vehicles: tent, hexayurt, hyparhut, dome, rv, car, truck, van; maybe
   bike). Communal/officer kinds stay out of `/start` and arguably `/bringing`.

### Bigger but well-specified
4. **Event-date picker is broken** — the `event_date` `DateInput` (a calendar with
   min/max) can't be clicked, shows weird month arrows, and "collapses" uglily at
   month boundaries. Asked-for replacement: a single row of clickable day buttons
   for the ~7–10 logical days in the event window — click the day you arrive/leave
   on. Affects EVERY `event_date` question ("a lot of dates around the program").
   → New compact day-picker control for `event_date` in `QuestionField.tsx`,
   driven by `eventWindowFor(year)`. (Stretch idea Cameron floated: arrival+exit
   on one calendar with two markers — defer; one-row day buttons first.)

### Design decisions / needs input or data config
5. **Tent size forced pick** — clicking Tent silently adds a 10×10; lots of people
   will leave the default. Want it to *prompt* for size on add. (UX: inline
   required size, or a small "how big?" popover.)
6. **Ride-share third button** — add "I don't have space in my ride" that
   auto-deselects the other ride-share options. This is a specific *question's*
   behavior, not generic — depends on how that question is configured (data).
7. **Burning Man profile optional** — a question asks for a BM profile and Blake
   didn't have his. "Make it optional for now." Likely a `required` flag on a
   seeded camp question (data config), not code.
8. **Redundant name/playa questions** — the wizard re-asks play name / name across
   steps. Need to dedupe profile vs questionnaire (data config + maybe code).
9. **Burner Express description** — add help text explaining Burner Express on the
   relevant question (data config).

### Needs reproduction
10. **Recruit could move map objects** — Blake (recruit) reported dragging boxes on
    the camp map. Code says `canEdit` requires member+, so this shouldn't happen
    for a recruit — needs in-browser repro to confirm whether it's the overview
    preview, a member-not-recruit account, or a real gating bug.
11. **Discord/passkey "not configured" messaging** — confusing wording on the
    overview ("Discord not configured on this deployment" / passkey register).
    Low priority polish.

### Explicitly out of scope (per Cameron, in transcript)
- The box-numbering / packing-binder system — that was a Math Camp discussion,
  not a CampTool change for now (may inspire a future inventory/packing feature).
- Map shade dark-mode legibility — Cameron noted it, not requested now.

## Decisions (locked with Cameron)
- Do everything across this and follow-up passes.
- **Camp questions are runtime admin config** (the `/questions` admin UI, stored
  in the DB) — so the "make optional / add help text / remove duplicate / add
  option" items are config changes *Cameron* makes in the UI, NOT seed code. The
  one exception is any *new behavior* a plain select can't do (the ride-share
  exclusive "no space" option) — that needs a small code enhancement plus the
  admin marking which option is exclusive.

## WORK LIST (the simple checklist to work from)

### Code — wizard & palette
- [x] **W1. Vertical stepper.** `start.tsx`: `Stepper orientation="vertical"`.
      Each step body now renders inline under its label; the wide-screen number
      wrap is gone.
- [x] **W2. Drop the Tickets step.** Removed the `tickets` ask from `ASKS`
      (`wizard.ts`), the `AskKey`, and `TicketsStep`/its case in `start.tsx`.
- [x] **W3. Trim the camper Bringing palette.** Added a `personal` flag to every
      `Kind` + a `CAMPER_KINDS` export in `structures.tsx`. personal = tent,
      hexayurt, hyparhut, dome, rv, car, truck, van, shade, Other. Excluded:
      kitchen, generator, container, spider box, camp art (officer-placed). The
      wizard `BringingStep` and `/bringing` now use `CAMPER_KINDS`.
- [x] **W4. Tent/structure size prompt.** New shared `app/components/AddStructures.tsx`:
      rigid kinds add immediately; sizable ones pop a "How big is your X?" size
      prompt before adding. `addItem` action (`bringing.tsx`) now honors an
      optional camper-picked width/height. Used by both the wizard and `/bringing`.

### Code — date picker
- **D1 (REVISED by Cameron 2026-06-16).** Not a per-question button row — a single
      reusable **`EventCalendar`** component: a fixed multi-week grid **centered on
      the event** (no month arrows — those were the bug), with the **event days
      highlighted**, where tapping a day sets the date. Same visual everywhere a
      date is chosen, so it's consistent. The day-button row was an interim step;
      replaced by the calendar.
  - [x] Build `app/components/EventCalendar.tsx` (year → window via `eventWindowFor`,
        event core days highlighted, tap-to-select single day, out-of-window days
        dimmed/disabled). Wire into `event_date` in `QuestionField.tsx`.
  - [ ] **D3 (future): camp events overlay.** The same calendar will also show camp
        events (public + private). Needs a `camp_event` entity (date/time, title,
        visibility public|private, camp_id + edition_id) — separate feature.
  - [ ] **D4 (follow-up): reuse everywhere.** Migrate the other date pickers
        (setup-pass dates `passes.tsx`, any arrival/strike dates) onto `EventCalendar`
        for the consistent visual.

### Code — questionnaire behavior
- [x] **Q1. Exclusive select option.** Added `camp_question.exclusive_option`
      (migration **0021**, additive ALTER). `QuestionField` multi_select honors it
      (`nextMulti`): picking the exclusive option clears the rest; picking another
      clears the exclusive one. Officers set it per-option via a ⊘ toggle in the
      `/questions` OptionsEditor (multi_select only); renaming/removing the option
      clears a stale flag. Threaded through both loaders. Pairs with admin A4.

### Admin config (Cameron, in the /questions UI — not code)
- [ ] **A1.** Mark the "Burning Man profile" question **not required**.
- [ ] **A2.** Add **Burner Express** help text to its question.
- [ ] **A3.** Remove the duplicate **name / playa name** question (the Profile
      step already collects playa name; sign-in already has the real name).
- [ ] **A4.** Set up the **ride-share** question options incl. the exclusive "no
      space" option (pairs with Q1).

### Needs reproduction / investigation
- [ ] **R1.** Recruit could drag map objects — repro in browser (overview preview
      vs editor vs gating bug). `canEdit` already requires member+, so confirm.
- [ ] **R2.** Discord / passkey "not configured" messaging is confusing — polish.

### Out of scope now (noted, not doing)
- Box-numbering / packing-binder system (Math Camp idea, future feature).
- Map shade dark-mode legibility.

## Progress log
- [x] 2026-06-16 Triaged the transcript; scope confirmed (do everything; questions
      are runtime admin config). Work list above is the durable checklist.
- [x] 2026-06-16 Landed all code items W1–W4, D1, Q1. typecheck + build green;
      biome clean on every edited file (the only remaining repo lint errors are
      pre-existing in files I didn't touch: entry.server.tsx, map.tsx, layout.tsx,
      routes.ts, and the drizzle migration meta JSONs). Migration 0021 generated
      (additive `ALTER TABLE camp_question ADD exclusive_option text`) — applies on
      next dev-server restart (the startup migrator; `db:migrate` doesn't work here).
      NOT yet browser-tested or committed.
- [x] 2026-06-16 D1 revised per Cameron: built `EventCalendar` (fixed grid centered
      on the event, event days highlighted, tap-to-select, out-of-window dimmed) and
      wired it into `event_date`, replacing the interim day-button row. Removed the
      dead `enumerateDays` helper. typecheck + build green; biome clean.
- [ ] **Next:** browser-verify the wizard (vertical stepper, no tickets step,
      trimmed palette + tent size prompt, EventCalendar date picker) and the
      exclusive option on /questions. Then commit. Future: D3 camp-events overlay
      (needs `camp_event`), D4 reuse EventCalendar for setup-pass/other dates.
      Cameron's admin-UI tasks A1–A4 remain.
</content>
</invoke>
