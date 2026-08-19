# Direction-agnostic member merge (design + build plan, 2026-08-19)

> Plan path: `plans/merge-symmetric.md`
> Parent plan: `plans/camptool.md`. Sibling: `plans/social-groups.md` (asked for
> in the same breath; independent work).

## Goal

Cameron has a real campmate who joined twice. The existing merge works, but the
officer driving it has to answer a question they cannot answer:

> **Keep this member** — *the account they can actually log into. This record
> survives.*

Nobody knows which account that is. The person themselves often doesn't — they
may have a passkey on one and a password on the other, or a Discord login on
one. Picking wrong is silent and unrecoverable: the merge moves the camp data
onto the survivor and deletes the duplicate membership, stranding the credential
that actually worked on a `user` row that is now in no camp.

**Make the direction not matter.** Merging A into B and merging B into A must
produce the same camp, the same person, the same working logins.

## Decisions already made (don't re-ask)

From Cameron, 2026-08-19 — he picked "fold the accounts too":

1. **The `user` rows merge as well, not just the memberships.** Passkeys,
   Discord links and the password all end up on one account, so whichever
   credential the human actually holds keeps working. This is the only thing
   that makes direction genuinely stop mattering; a data-only merge still
   silently picks a winner in the auth layer.
2. **One email becomes primary; the other is recorded as an alias.** The alias
   is *bookkeeping* — so an officer searching the old address still finds the
   person. It is explicitly **not** wired into sign-in (that was the third
   option offered and Cameron did not take it). Typing the old address at the
   sign-in form will not work; the passkey/Discord/password will.
3. **Field resolution is by rule, not by which record was clicked.** Highest
   role wins, earliest join date wins, blanks fill from either side. Where both
   sides hold a *different* non-blank value that a rule can't settle (two
   different playa names), the modal asks — once, explicitly, as a field-level
   pick rather than as an abstract "which record survives".

Implied and worth writing down:

4. **Merge becomes a privilege-escalation surface, so authorization tightens.**
   Once credentials fold, "merge my account with an admin's" would hand the
   actor an admin membership their own passkey opens. The actor must therefore
   strictly outrank **both** records and be neither of them. See
   *Authorization* below — this is the one place the change is deliberately
   *more* restrictive than today.
5. **A surviving row id is still chosen** — SQL needs one — but by a
   deterministic rule (earliest `joined_at`, tie-break on id), never by the
   click. That is an implementation detail, not a question for the user.

## Environment / context

- Repo `C:\Users\camer\git\Personal Projects\CampTool`, branch `master`.
- Live at `camptool.mathcamp.us` (no `/dashboard` route prefix).
- Server: `app/lib/merge.server.ts`. UI + action: `app/routes/dashboard/members.tsx`
  (`intent=mergeMembers` at `:440`, `intent=previewMerge` at `:522`, modal at
  `:1061`).
- Ranks: `app/lib/permissions.ts` (`rankOf`, `ROLE_RANK`, admin > officer >
  member > recruit).
- Schema: `db/schema/camp.ts` (`membership`), `db/schema/auth.ts` (`user`,
  `account`, `passkey`, `session`).

## Why direction currently matters — the mechanics

`mergeMemberships` (`merge.server.ts:187`) is asymmetric in three places:

| Thing | Today | Consequence of picking "wrong" |
|---|---|---|
| Role | survivor keeps its own | merging the officer record into the member record demotes them |
| `playa_name` | filled only if survivor's is blank | the newer, wronger name can win |
| `user` row | untouched; stale membership is deleted, stale user is left orphaned | **the credential that worked is now attached to no camp** |

The third is the real one. `membership.user_id` is `ON DELETE CASCADE` *from*
user, but deleting a membership does nothing to its user — so the stale account
survives, can still sign in, and lands in a camp-less app.

## Design

### One symmetric primitive

```
mergeMembers(campId, idA, idB) -> MergeOutcome
```

Order-independent by construction: it sorts the pair itself. A `resolve` step
produces the final field values from both rows; a `survivorId` is then chosen
(earliest `joined_at`, tie-break lexicographic id) purely so there is a row to
write them onto.

### Field resolution table

| Field | Rule | Why |
|---|---|---|
| `role` | highest rank | a merge must never demote; the person *is* an officer if either record says so |
| `joined_at`, `created_at` | earliest | the relationship began when it began |
| `playa_name` | non-blank; both non-blank and different → **ask** | renaming someone silently is the complaint that started this |
| `status` | `active` beats anything else | same shape as `statusProgress` in the prospect merge |
| `wizard_step` | max | furthest progress is the true progress |
| `wizard_completed_at` | earliest non-null | |
| `invited_by_membership_id` | the non-null one; if both, the earlier-joined record's | provenance feeds `plans/social-groups.md`, so don't drop it |
| `via_invite_id` | same | |
| `user.name` | non-blank; both differ → **ask** | |
| `user.email` | earlier-created account's is primary; the other becomes an alias | arbitrary but stable, and both are shown |
| `user.image` | non-blank | |
| `email_verified` | true if either | |

Everything else — every FK anywhere in the database pointing at `membership` or
`user` — is re-pointed by the existing runtime `PRAGMA foreign_key_list` sweep.
That sweep is the reason a table added later is covered without anyone editing
this file, and it stays the mechanism.

### Folding the accounts

After the membership merge, in the same transaction:

- **`passkey`** — all rows move. `credential_id` is globally unique, so there is
  never a collision; both devices keep working.
- **`account`, social providers (Discord)** — move. A user can hold several.
- **`account`, `credential` provider** — at most one may exist per user or
  better-auth's password paths get ambiguous. If only one side has a password,
  it moves. If **both** do, the survivor's is kept and the other is dropped;
  the modal says so, because "your other password stopped working" is exactly
  the kind of surprise this whole change exists to prevent.
- **`session`** — dropped on both sides. The person re-authenticates once, with
  whatever credential they have. Same reasoning as the password reset flow
  (`plans/password-recovery.md`): a merge is an identity event.
- **Other camps.** The stale user may be a member of camps this camp's officers
  can't see. Those memberships re-point to the survivor user like everything
  else — it is the same human — so the merge must never be scoped to just this
  camp's rows. If that produces two memberships in one *other* camp, that camp
  now has an ordinary duplicate to merge; it is not this camp's business and not
  an error.
- **`user_email_alias`** (new table) records the dropped address, plus which
  user it belonged to and when it was folded.

### Authorization (tightened)

Current rule (`members.tsx:459`): actor must strictly outrank the record being
absorbed, and may not absorb their own.

New rule, because either record can now be the one that survives and the merged
account answers to both sides' credentials:

- actor must **strictly outrank both** records;
- actor may be **neither** of them.

Consequence, stated so nobody rediscovers it as a bug: **two `admin` duplicates
cannot be merged by an admin**, because nobody strictly outranks admin. The
super-admin escape hatch exists (`super_admin` table) and is the right home for
that case if it ever comes up; not building it now.

### The modal

Replaces "pick the survivor" with "here are two records, here is the person they
become". Both records side by side (name, email, role, joined, sign-in methods,
row counts), the resolved result underneath, and a radio pick for each genuine
conflict. Button: **Merge into one member**.

The preview must state, in words: which email becomes primary, which sign-in
methods will work afterwards, and whether a second password is being dropped.

## Plan / steps

- [x] 1. `user_email_alias` table + migration `0076_handy_speedball.sql`
      (`db/schema/identity.ts`).
- [x] 2. `planMerge()` — pure, in `app/lib/merge-plan.ts`, no database import so
      the symmetry property can be tested exhaustively.
- [x] 3. `mergeMembers()` — symmetric; folds memberships, attendees, users,
      credentials; drops sessions; writes the alias.
- [x] 4. `planMemberMerge()` returns the resolved person + conflicts + row counts
      from both the stale membership *and* the stale user.
- [x] 5. Members page: new modal, tightened authorization, `mergeMembers` intent.
- [x] 6. `merge-plan.test.ts` (14) + `e2e/member-merge.ts` (16).

## Things not to do

- **Don't ask the officer which account can log in.** That question is the bug.
- **Don't scope the user fold to this camp.** Half-moving a human between camps
  is worse than not moving them.
- **Don't keep two `credential` rows** on one user.
- **Don't silently drop a password** — say it in the preview.
- **Don't let the actor be one of the two records.** With credentials folding,
  that is account takeover with extra steps.

## Progress log

- [x] 2026-08-19 — Asked Cameron; he chose the full account fold with a recorded
      (non-sign-in) email alias. Audited the current merge and the FK graph:
      31 tables reference `user`, all covered by the existing runtime sweep.
- [x] 2026-08-19 — **Built and verified.** `bun run e2e:member-merge` is 16/16
      against a throwaway DB, and it is deliberately built as *two identical
      duplicate pairs merged in opposite directions*, then compared: assertion
      16 is that both produced the same person. It also proves the account fold
      concretely — the second account's passkey and Discord login end up on the
      surviving user, the first account's password still signs in over HTTP, the
      folded-away address does not, the duplicate `user` row is gone, and the old
      address is on file as an alias. `merge-plan.test.ts` adds 14 unit tests
      including an all-pairs sweep asserting `planMerge(a,b)` deep-equals
      `planMerge(b,a)`. typecheck, biome, 290 unit tests green.

      Two things worth knowing that only showed up while building:

      1. **A merge can make a membership its own inviter.** If one duplicate
         invited the other, the "keep whichever side has provenance" rule fills
         `invited_by_membership_id` with the survivor's own id. There is now an
         explicit `UPDATE … WHERE id = ? AND invited_by_membership_id = ?` right
         after the resolved write to null that out. Worth remembering when
         `plans/social-groups.md` starts walking the tree — a self-edge is an
         infinite loop, not a curiosity.
      2. **Sign-in method reporting has to come from the plan, not the UI.** The
         success toast now names what will still work ("2 passkeys, password,
         Discord"), and it reads that off the same resolved plan the merge
         executed, so the message cannot drift from the outcome.
