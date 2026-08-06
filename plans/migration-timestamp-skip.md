# Migration 0066 silently skipped in production — `/map` 500s

## Goal

Fix the production outage on <https://camptool.mathcamp.us/map> ("Something went
wrong / Unexpected Server Error"), and make the underlying failure mode
impossible to repeat.

## Symptom

`/map` returns a 500 while the rest of the app is fine. Server log on firefly:

```
SQLiteError: no such column: map_object.place_near_vehicle
  at prepare (bun:sqlite:331:37)
  at prepareQuery (drizzle-orm/bun-sqlite/session.js:20:30)
```

The failing query is the map loader's `objectRows` select
(`app/routes/dashboard/map.tsx:1111`), which selects `map_object.place_near_vehicle`.

## Root cause

`place_near_vehicle` is added by migration **0066_living_retro_girl** (commit
8c0238e). The migration file and journal entry are committed, they shipped in the
deployed release, and yet the column does not exist in the production database.

Drizzle's migrator does **not** track which migrations ran. It reads the single
most-recently-applied row from `__drizzle_migrations` and applies only migrations
whose journal `when` is strictly greater
(`drizzle-orm/sqlite-core/dialect.js:660`):

```js
const lastDbMigration = dbMigrations[0] ?? void 0;   // read ONCE, before the loop
for (const migration of migrations) {
  if (!lastDbMigration || Number(lastDbMigration[2]) < migration.folderMillis) { ... }
}
```

The journal timestamps are **not monotonic**:

| idx  | tag                        | `when`        | ISO                      |
| ---- | -------------------------- | ------------- | ------------------------ |
| 64   | 0064_shallow_mandarin      | 1785465902568 | 2026-07-31T02:45:02.568Z |
| 65   | 0065_fix_missing_on_delete | 1785552302568 | 2026-08-01T02:45:02.568Z |
| 66   | 0066_living_retro_girl     | 1785539885096 | 2026-07-31T23:18:05.096Z |

0065 is a **hand-written** migration (commit d61bc46, "Fix member/guest deletion:
repair five wrong ON DELETE rules"). Its `when` was authored as
`0064 + 86400000` — exactly 24 hours later — which put it ~3.5 hours *ahead* of
the real clock. drizzle-kit then generated 0066 with the true wall clock, landing
**before** 0065.

Production had already applied through 0065, so `lastDbMigration.created_at` =
`1785552302568`. Since `1785539885096 < 1785552302568`, migration 0066 is skipped
— silently, on every boot, forever.

### Who is and isn't affected

- **Production** (last applied = 0065's fabricated stamp): broken. This is the
  only DB in that state.
- **Fresh installs**: fine. `lastDbMigration` is `undefined`, so the gate is
  bypassed and every migration applies in journal order.
- **Local dev DB** (`data/camptool.db`, last applied = 0064's stamp
  `1785465902568`): fine. Both 0065 and 0066 exceed it, so both apply on next
  boot. Verified: it is currently missing the column and will self-heal.

### Why `scripts/verify-migrations.ts` didn't catch it

That script applies every journal entry **in array order to a fresh scratch DB**.
A fresh DB never exercises the timestamp gate, so an out-of-order `when` passes
cleanly. The script also isn't run anywhere — it is not in `package.json`
scripts and there is no CI workflow but `deploy.yml`.

## Decisions already made (don't re-ask)

- **Lower 0065's `when`, never raise 0066's.** Raising a migration's timestamp can
  make an already-applied migration re-run on a DB that has it (fresh installs
  would hit `duplicate column name: place_near_vehicle` at boot). Lowering 0065
  can only ever cause a migration to be *skipped* on a DB that already ran it,
  which is correct. Checked against all three populations above — safe for each.
- **New value = `1785534973000`**, the 0065 commit's own author timestamp
  (2026-07-31T21:56:13Z). Honest, and strictly between 0064 and 0066.
- **Repair production with a one-row `UPDATE`**, not by hand-applying the ALTER.
  Correcting the wrongly-recorded `created_at` lets the normal migrator apply
  0066 on the next boot, which keeps prod's migration history truthful.
- **Guard belongs in `verify-migrations.ts` + CI.** The invariant that makes
  "apply in array order" equivalent to drizzle's gated behaviour is exactly
  strict monotonicity of `when`. Assert it, and run the script in CI.

## Plan / steps

1. [x] Diagnose — read firefly server logs, confirm the skipped migration.
2. [x] Fix `db/migrations/meta/_journal.json`: 0065 `when` → `1785534973000`.
3. [x] Add guards to `scripts/verify-migrations.ts`: strictly-increasing `when`,
       contiguous `idx`, and journal/folder agreement.
4. [x] Add `db:verify` to `package.json` and run it in `deploy.yml` before build.
5. [x] **Repair production** (authorized 2026-08-06): backed up to
       `/srv/camptool/data/camptool.pre-0066-repair.db` (integrity ok, 66
       migrations / 48 map_objects / 34 users), then applied the one-row
       `UPDATE __drizzle_migrations SET created_at = 1785534973000 WHERE created_at = 1785552302568;`
       (guarded to refuse unless exactly one row matched).
6. [x] Deployed `3dbbb22`. 0066 applied on boot: 67 migration rows, newest stamp
       `1785539885096`, `place_near_vehicle` present, row counts unchanged.
       `/map` renders fully; zero `SQLiteError` in the log since restart.

## Status: resolved

Production is fixed. The backup at
`/srv/camptool/data/camptool.pre-0066-repair.db` can be deleted once you're
satisfied — it is a pre-repair snapshot, so restoring it would reintroduce the
bug; it exists only as an undo for the `UPDATE` itself.

### Follow-ups (not blocking, not done here)

- **The push to master did not create a workflow run.** `3dbbb22` reached
  `refs/heads/master`, Actions was enabled, and the `firefly-camptool` runner was
  online and idle, but GitHub created no run — the deploy had to be started with
  `gh workflow run`. Every prior push (through 2026-07-31) triggered normally.
  Worth watching on the next push; if it recurs, it is a GitHub-side trigger
  problem, not a workflow-file one.
- **`bun run typecheck` fails with `TS2688: Cannot find type definition file for
  'node'`.** Pre-existing and unrelated: `@types/node` is not declared in
  `package.json` at all, while `tsconfig.json` asks for the `node` types library.
- **`bun run lint` reports 8 pre-existing format errors** on
  `db/migrations/meta/*.json` (CRLF line endings on drizzle-generated files).
  Pre-existing; a prior reformat of these was deliberately reverted (see
  `stash@{1}`, "pre-revert snapshot: … biome reformat of 0058-0062 drizzle
  snapshots"), so leaving them alone looks intentional.

## Findings / gotchas

- **drizzle's migrator is timestamp-gated, not hash-gated.** The `hash` column is
  recorded but never compared. Any migration whose `when` predates the newest
  applied row is skipped in silence — no warning, no error, no log line.
- `lastDbMigration` is read **once**, before the loop. That is why a fresh install
  applies everything regardless of ordering, and why the bug only bites a database
  that sat at the out-of-order migration when the next one arrived.
- The production `__drizzle_migrations` table has 66 rows with 66 distinct
  `created_at` values, matching journal entries 0000–0065. Exactly one migration
  (0066) is unapplied. No duplicates to untangle.
- The runner container `camptool-runner` hosts the app itself (`/srv/camptool`),
  it is not a separate container. `ps` is not installed; use `docker logs
  camptool-runner`. Prod DB is at `/srv/camptool/data/camptool.db` *inside* that
  container.
- `ssh firefly` has `RemoteCommand screen -RRD` in `~/.ssh/config`; non-interactive
  use needs `ssh -o RemoteCommand=none -T firefly`.

## Things not to do

- **Never hand-author a journal `when` in the future**, or by arithmetic on the
  previous entry. Use the real clock; if writing a migration by hand, let
  drizzle-kit generate the journal entry, or use `Date.now()` at authoring time.
- **Don't raise a migration's `when` to fix ordering.** It re-runs the migration
  on databases that already applied it. Lower the offending later-stamped one
  instead.
- Don't "fix" prod by running the `ALTER TABLE` by hand — that leaves
  `__drizzle_migrations` claiming 0066 never ran, so the next person to reason
  about the chain is misled, and a future rebuild-style migration could re-add it.
- Don't add a 0067 that repeats the ALTER. Fresh installs apply 0066 *and* 0067
  and die on `duplicate column name`.
