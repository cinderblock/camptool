# Accessibility — review findings & first-class roadmap

> Plan path: `plans/accessibility.md`
> Goal (Cameron, 2026-07-05): accessibility as a **first-class feature — above
> and beyond** normal compliance. This doc: current-state review, prioritized
> fixes, and the beyond-compliance roadmap.

## How this was reviewed

- Three parallel code reviews (all of `app/components/`, the public funnel +
  wizard, all dashboard routes incl. the map editor).
- Live axe-core 4.10 runs against camptool.mathcamp.us on `/`, `/guide`,
  `/start` (dark theme, member session).

## Current state, honestly

**Zero `aria-*` attributes exist in app code.** Everything accessible today is
inherited from Mantine defaults (real `<table>`s, labeled inputs via
`Input.Wrapper`, modal focus traps, tabs semantics — those are genuinely fine).
Everything custom-built is visual-only. Rough WCAG 2.1 AA standing: ~65%.
Axe on live pages: `color-contrast` (serious) on every page (6–16 nodes — the
`c="dimmed"` text on dark), no `<h1>` anywhere (pages start at `Title order=2`),
heading-order skips (h2→h4 on /guide), and `/start` renders outside any `<main>`
landmark.

## Findings (deduplicated, by severity)

### Blockers

1. **Map editor is 100% pointer-only** (`map.tsx`). No keyboard path to place/
   move/rotate anything; the SVG has a single `aria-label` and no non-visual
   representation of its contents. Screen-reader and keyboard users get
   nothing. (Fix sketch below — this is also the flagship "beyond" feature.)
2. **EventCalendar day grid** (`EventCalendar.tsx:84-190`): bare
   `UnstyledButton`s — no accessible name (just "30"), no `aria-pressed`/
   `aria-selected`, selection is color-only, no `role=grid`/row/columnheader,
   no arrow-key navigation (should be roving tabindex), callouts (Gates/Burn/
   Temple/Exodus) only in `title`.
3. **No skip link; no focus management** on route change (`root.tsx`) or wizard
   step advance (`start.tsx` next/back) — keyboard/SR users lose their place at
   every transition; step changes and the final "You're all set!" are silent.
4. **Silent async feedback**: the whole "answers save as you go" pattern (wizard,
   question fields, onBlur profile saves, stay-picker taps) has no `aria-live`;
   Mantine `Alert`s used for errors/success (`c.$slug`, `i.$token`, wizard) have
   no `role=alert`. SR users never learn saves happened or errors appeared.

### Serious

5. **Toggle button groups are color/variant-only**: RSVP I'm-coming/Maybe/Not
   (`start.tsx` RsvpButtons), single/multi-select and Yes/No question buttons
   (`QuestionField.tsx`) — need `aria-pressed` and a non-color selected cue.
6. **Color-contrast failures** on dimmed text (axe-verified, every page) and
   `opacity: 0.3` out-of-window calendar days.
7. **Icon-only controls without names + hover-only Tooltips**: remove ✕
   ActionIcons (`bringing.tsx`, occupants, tickets), Copy buttons, Burger menu
   (no aria-label), user-menu UnstyledButton, table row actions missing row
   context ("Accept" — accept *whom*?).
8. **JoinFlowchart** reads as glyph soup ("↓ ↓ ◀ next year ↺") — decoration
   needs `aria-hidden` plus a visually-hidden ordered-list narrative.
9. **Document structure**: no h1s, heading skips, `/start` outside `<main>`,
   nav lacks `aria-current` on the active item.

### Moderate (batch fixes)

- Conditional reveals unannounced (I'm-coming → stay picker; been-before →
  playa name; feedback type swap).
- Badge status color-only everywhere (recruit status, invite type/status,
  ticket/pass status, roles) — add icons/prefixes; ensure contrast.
- Layout selects unlabeled (camp switcher); impersonation banner not announced.
- Required-field red asterisk only (pass `required` through to inputs).
- Magic-link button not disabled while busy (double-fire).
- Stat blocks (`tickets.tsx`) as unassociated text — use `<dl>`.
- `CampHero` logo alt = camp name → `"{name} logo"`.

## Fix plan (phases)

- **Phase A — infrastructure (small, unlocks everything):**
  `<Announcer>` in root: two visually-hidden live regions (polite + assertive)
  plus a tiny `announce(msg, {assertive})` helper; skip-to-content link; focus
  main on route change; h1/landmark/heading-order sweep; give `/start` a main.
- **Phase B — the loud gaps:** aria-pressed on all toggle groups; role=alert on
  Alerts + announce() on fetcher ok/error; announce saves ("Saved") and step
  changes; label every icon-only control (Tooltip text → aria-label too);
  aria-hidden the decorative glyphs + flowchart sr-narrative.
- **Phase C — EventCalendar proper ARIA date-grid:** role=grid/row/columnheader,
  full-date aria-labels with selection state, roving tabindex + arrow keys,
  announce selections ("Arrival Sun Aug 30 — now pick your last day").
- **Phase D — map parity view (flagship):** list/table view of every placed
  object (kind, name, size, position, owner, status) with keyboard actions —
  select→arrow-keys to nudge, +/- size, R rotate, announce every change; view
  toggle Map/List. Useful to *everyone* (search/filter/sort), which is what
  makes it first-class rather than bolt-on.
- **Phase E — theme & prefs:** fix dimmed-text contrast at the theme level;
  respect `prefers-reduced-motion`; colorblind-safe status palette with icon
  reinforcement; optional high-contrast toggle + font-size setting (per-user,
  persisted).
- **Phase F — keep it accessible:** enable Biome's `a11y` lint group to error;
  axe smoke-test in CI against key routes; `ACCESSIBILITY.md` statement (this
  is open-source — self-hosting camps have disabled members); manual NVDA
  pass on the joining funnel each release.

## Above and beyond (what makes it first-class)

- The **map list-view parity** feature (Phase D) — genuine equivalent access to
  the most visual thing in the app, not a disclaimer.
- **Everything announced**: the app talks back on every async save/state change
  via one consistent announcer, instead of hoping users notice pixels.
- **Keyboard-first everywhere**, with a `?` shortcuts help dialog.
- **User a11y preferences** stored per-account (contrast, motion, font size) —
  self-hosted camps serve their actual members, not an abstract audience.
- **CI enforcement** so it never regresses (lint + axe + manual checklist).

## Progress log

- [x] 2026-07-05 Review completed (3 code-review agents + live axe). Findings
      above. No fixes applied yet.
- [x] 2026-07-05 Phase A landed: `app/components/Announcer.tsx` (visually-
      hidden polite+assertive live regions + `announce()` helper + SkipLink),
      mounted in root; focus moves to `#main-content` on client navigation
      (skipped on first load); main landmarks: AppShell.Main, /start, /login,
      /c/ (NOT /i/ — peer session mid-flight there); h1s via
      `Title order={1} size="h2"` on dashboard/guide/start/login + guide
      section levels fixed. Mantine facts verified live: Alert already has
      role="alert"; notifications announce themselves — the announcer is for
      everything else.
- [x] 2026-07-05 Phase B landed: aria-pressed on RSVP + question button
      groups; EventCalendar day buttons get full spoken labels ("Sunday,
      August 30, gates open, arrival") + aria-pressed + tap announcements
      ("Arrival … — now pick your last day" / "Stay set: …"); wizard step
      changes announced ("Step 2 of 6: Questionnaire"); "Answer saved."
      announced on question saves; RSVP choice + stay-picker reveal announced;
      PlayaNameField reveal announced; JoinFlowchart visual aria-hidden with a
      VisuallyHidden ol narrative; required asterisk paired with sr-only
      "(required)"; ✕ remove ActionIcons labeled (start occupants/items,
      bringing); Burger/camp-Select/user-menu labeled; impersonation banner
      role=status; ContactFix results role=alert / <output>; magic-link
      double-fire guard; CampHero alt "{name} logo". Biome's a11y lint rules
      confirmed ACTIVE (they caught 3 things during this pass).
      Deferred from this pass: /i/ main landmark (peer-owned file right now),
      map.tsx anything (Phase D), EventCalendar arrow-key roving tabindex
      (Phase C), contrast theme work (Phase E).
- [ ] Phase C EventCalendar grid
- [ ] Phase D map parity view
- [ ] Phase E theme & prefs
- [ ] Phase F CI + statement
