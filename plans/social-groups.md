# Social groups + the invite tree (design + build plan, 2026-08-19)

> Plan path: `plans/social-groups.md`
> Parent plan: `plans/camptool.md`. Siblings: `plans/party-member-links.md`
> (households — a *different*, narrower thing; see below), `plans/merge-symmetric.md`.

## Goal

Cameron: *"I want to see the camp membership & roster as nested/grouped things.
We should already track who invited who. I want to easily group campers into
known logical social groups (and/or let them do so, and use the invite link
provenance)."*

A camp of 60 is not a flat list of 60 — it is "the fire crew", "Albert's
people", "the Santa Cruz carpool". The roster and directory should read that
way, and most of the raw material is already in the database.

## What already exists (don't rebuild it)

- **Invite provenance is tracked.** `membership.invited_by_membership_id` is
  literally commented "Invite-tree edge" (`db/schema/camp.ts:115`), and
  `membership.via_invite_id` records the door even when an open link records no
  personal inviter. The members page already renders a flat "Invited by" name
  (`members.tsx:173`). **Nothing renders the tree.**
- **Households already have a concept, and it is not this one.**
  `plans/party-member-links.md` defines a *party*: one anchor, one level deep,
  and it is **load-bearing for authority** — a party host can manage their
  party's tickets and setup passes. Social groups must stay **purely
  descriptive**: no permissions, ever. Two people can be in the same group
  without either gaining reach over the other. Keeping these separate is the
  single most important constraint here.

## Decisions already made (don't re-ask)

From Cameron, 2026-08-19:

1. **Named groups, plus the invite tree as its own view.** Provenance is a fact;
   a social group is a judgement. They drift — someone invited by an officer
   they barely know is not "in that officer's group". So the tree does not
   *define* groups; it *suggests* them and is worth seeing on its own.
2. **Anyone can create a group and add people; officers tidy.** Any member may
   create a group, add themselves, and add others (same high-trust reasoning as
   the party link). Officers can rename, merge and delete groups.
3. **All three surfaces:** roster, members directory, and the map.

Implied, and worth writing down:

4. **Groups are flat and overlapping, not a hierarchy.** A member belongs to
   any number. The "nesting" Cameron asked for is delivered by (a) collapsible
   group sections on the two lists and (b) the genuinely n-deep invite tree.
   A `parent_group_id` is not being added until something actually needs it.
5. **No permissions attach to a group.** See above.

## Design

### Schema (new, `db/schema/group.ts`)

```
camp_group
  id, camp_id → camp (cascade)
  name, description?
  color?                       -- drives the map tint and the section chip
  created_by_membership_id?    -- set null; who started it
  created_at
  unique (camp_id, name)

camp_group_member
  id, camp_id → camp (cascade)
  group_id → camp_group (cascade)
  membership_id → membership (cascade)
  added_by_membership_id?      -- set null
  created_at
  unique (group_id, membership_id)
```

Camp-scoped (the hard multi-camp invariant), *not* edition-scoped: a social
group outlives one year. Membership in a group is likewise year-independent —
the roster filters it by who's actually coming.

### The invite tree

Derived at read time from `invited_by_membership_id`; no new storage. Roots are
memberships with no inviter (founder, public applicants, officer-added). Needs
a cycle guard — the column is self-referential and nothing stops a merge or a
hand-edit from producing a loop.

Its payoff beyond looking nice: **"make this subtree a group"** — one action
that creates a named group seeded with an inviter and everyone below them.
That is the "use the invite link provenance" half of the ask, and it turns a
fact into a judgement exactly once, under a human's hand.

### Surfaces

**Roster** — a `Group by` control: *None* (today's flat list) / *Social group* /
*Invited by*. Sections are collapsible, each with its own headcount. Someone in
two groups appears in both sections; the page states the real total separately
so the arithmetic is never a lie.

**Members directory** — the same control, plus the tree view and the officer
tidy-up actions (rename / merge / delete a group).

**Map** — tint objects by their owner's group, with a legend. Reuses the party
highlight plumbing (`app/lib/party-map.server.ts`, `?party=`). A member in
several groups gets the first by name order; the legend says so.

## Plan / steps

- [x] 1. Schema + migration `0077_cynical_aqueduct.sql` (`db/schema/group.ts`).
- [x] 2. `app/lib/groups.server.ts` (CRUD, add/remove, group merge) and
      `app/lib/invite-tree.ts` (pure tree builder, `subtreeIds`, `flattenTree`).
- [x] 3. Members directory: a **Show as** control — flat list / social groups /
      who invited whom — plus a groups panel and "Make a group" on any tree node.
- [x] 4. Roster: a **Group by social group** toggle with sections and headcounts.
- [x] 5. Map: `/map?group=<id>`, reusing the party highlight.
- [x] 6. `invite-tree.test.ts` — 10 tests, including both cycle shapes.
- [ ] Remaining UI: rename / merge groups. Both actions and server functions
      exist and are authorization-checked (officer-only); only the buttons are
      missing, so an officer currently deletes and recreates instead.

## Feature gating

Shipped as the `groups` camp feature with `starter: true`, so it is on for
existing camps and pre-enabled for new ones, and a self-hoster who doesn't want
it can switch it off. It gates the members control, the roster toggle, and the
group actions; `/map?group=` simply resolves nothing when the camp has no
groups.

## Things not to do

- **Don't attach any permission to a group.** Authority lives on the party link
  and on roles. A group that grants reach is a party, and that already exists.
- **Don't auto-create groups from the invite tree.** Suggest; never assume.
- **Don't make the tree the grouping model** — see decision 1.
- **Don't scope groups to an edition.** They outlive a year.

## Progress log

- [x] 2026-08-19 — Design agreed with Cameron (four answers above). Confirmed
      the provenance columns already exist and that nothing renders the tree.
- [x] 2026-08-19 — **Built and driven in a browser** against a copy of the dev
      database seeded with a four-deep invite tree. The tree renders nested with
      a "brought N" count per node; "Make a group" turned a subtree into a real
      group; the roster grouped into sections whose counts still sum to the
      headcount; `/map?group=` lit up six objects with the banner reading
      "Showing Cameron Tacklind's crew".

      Three things worth keeping:

      1. **The roster files each person under exactly one group; the members
         page doesn't.** They are different pages: the roster is fundamentally
         about *how many people are coming*, and a row appearing under two
         headings makes a reader count them twice no matter how the totals are
         worded. So the roster picks the first group alphabetically as a
         person's home and prints every group they're in beneath their name; the
         directory, which has no arithmetic to protect, lists them under each.
      2. **The "↳" marker is tree-only.** It first appeared on group rows too
         (both indent), where it reads as "invited by the row above" and is
         simply false. Indentation is shared; the arrow is not.
      3. **Group sections filter the already-sorted member list** rather than
         mapping the group's stored ids, so every section keeps the page's
         rank-then-name order instead of showing people in the order somebody
         happened to add them.
