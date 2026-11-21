# Issues

Problems found while working on something else. Each is just enough to seed a
fresh agent; claim one (`in progress — <thread/branch>`) before working on it.

## Site admin backup's `camptool.sql` likely won't restore into D1

`dbSnapshot()` in `db/host/d1.ts` writes `PRAGMA foreign_keys=OFF; BEGIN
TRANSACTION;`, then rows table by table in name order. D1 ignores
`foreign_keys=OFF`, checks foreign keys row by row on import, and rejects
`BEGIN TRANSACTION` in a SQL file. Restoring a `wrangler d1 export` the same way
failed on 2026-11-21 with "no such table: main.user" and then "FOREIGN KEY
constraint failed" until rows went parent-first (`scripts/order-d1-dump.ts`).
The documented restore (`docs/cloudflare-deploy.md` → Backups, "Into a fresh
D1") is untested against this. It matters because it's the backup people rely on
to move or recover a camp.
