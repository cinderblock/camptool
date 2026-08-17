# Making `/export-db` a complete backup

> Task plan. Parent living plan: `plans/camptool.md` (read that first).
> Sibling: `plans/pictures-in-bodies.md` — the change that created this problem.
> Plan path: `plans/complete-backup.md`

## Goal (user ask, 2026-08-17)

> "upgrade the export to be a complete backup. it's not very useful if it
> convinces me it's a complete backup when its not"

Moving picture bytes to disk left `/export-db` handing back only the SQLite
file: every picture's metadata, none of its images. The previous turn's answer
was to *document* the gap in three places. That was the wrong shape of fix —
a backup's whole value is the confidence that restoring it works, and a
prominent warning is not a substitute for the bytes.

## Decisions

1. **One download, both halves.** `camptool.db` + every file under the uploads
   directory, in a single archive. No "and also remember to copy this folder".
2. **`.tar.gz`, not `.zip`.** A tar is `header, data, header, data, …` on a
   fixed 512-byte block, so it can be written one file at a time with bounded
   memory and has no 4 GB archive ceiling. A zip's central directory needs
   every entry's CRC and compressed size, which means either buffering the
   whole archive or implementing ZIP64. Cameron is on Windows 11, which reads
   `.tar.gz` natively in both Explorer and `tar.exe`, and the restore target is
   a Linux server — so zip's familiarity advantage doesn't apply here.
   ~90 lines of USTAR writer (`app/lib/tar.ts`), no dependency.
3. **No wrapping directory.** Entries are `camptool.db` and `uploads/…`, so
   restore is one command that lands everything where it came from:
   `tar -xzf <file> -C /srv/camptool/data`.
4. **The disk is the source of truth, not the `camp_image` table.** A backup
   preserves what EXISTS. A file whose row was lost is still backed up; the
   table is consulted only to cross-check and report.
5. **A `MANIFEST.txt` that admits problems.** It lists contents, the restore
   command, and — the point — any picture row whose file was already missing.
   Given the ask, a backup that silently omits something is the failure being
   fixed; it has to say so out loud.

## Layout

```
camptool-backup-YYYY-MM-DD.tar.gz
├── MANIFEST.txt              contents, restore command, integrity report
├── camptool.db               sqlite.serialize() — point-in-time, WAL included
└── uploads/<camp-id>/<id>    every picture, full resolution (+ .display copies)
```

## Findings / gotchas

- **Bun 1.3 does not define `CompressionStream`.** The first implementation used
  the web streams API and would have 500'd the route in production; the unit
  test caught it (`ReferenceError: CompressionStream is not defined`). Gzip now
  goes through `node:zlib`'s `createGzip()` wrapped with `Duplex.toWeb()`, which
  still streams. **Don't reach for `CompressionStream` anywhere in this repo.**
- **A peer Claude session already held port 17927.** The scratch server silently
  failed to bind, every e2e request went to *that* session's app, and its writes
  landed in `data/verify/uicheck.db` — so the e2e read its own DB and found no
  users. Symptom: "no user row for owner" while sign-up returns HTTP 200.
  **Check `netstat` for a listener on your port before trusting an e2e run**,
  and confirm the DB file you passed is the one growing.
- **The first account on a fresh deployment is auto-granted super admin**, so
  seeding one explicitly needs `onConflictDoNothing()`.
- `readdir(dir, { withFileTypes: true })` annotated with
  `Awaited<ReturnType<typeof readdir>>` picks the Buffer overload and breaks
  `item.name`. Let it infer.

## Verification

- 12 unit tests over the tar writer, including a **deliberately independent
  reader** that verifies the checksum and USTAR magic the way an extractor
  would — a format that only round-trips through its own assumptions is how you
  get an archive no real tool can open.
- `e2e/backup.ts` (13 checks) over HTTP: the super-admin gate, a real gzip of a
  real tar, `camptool.db` carrying SQLite's magic bytes, the picture present
  **byte-for-byte**, and the manifest telling the truth after a file is deleted
  out from under it.
- **Opened with real GNU tar**: `tar -tvzf` lists it, `tar -xzf` extracts it,
  nested `uploads/<camp>/<id>` paths survive, and the restored `camptool.db`
  starts with `SQLite format 3`.

## Things not to do

- Don't use `CompressionStream` (see above).
- Don't buffer the archive in memory — pictures are full-resolution originals.
- Don't add a wrapping directory; it breaks the one-command restore.
- Don't let the manifest claim completeness it can't deliver. If something is
  missing, name it.
- Don't back up only what the database knows about.

## Progress log

- [x] 2026-08-17 — `app/lib/tar.ts` (USTAR writer) + `backup.server.ts`
      (walk, cross-check, manifest, streamed gzip); `/export-db` rewritten;
      Site admin copy, `docs/firefly-deploy.md`, `.env.example` and README all
      re-stated as a complete backup. 12 unit + 13 e2e checks, plus a real-tar
      extraction. Typecheck / lint / build green.

## Still open

- **Restore is manual** (`tar -xzf` + restart). An in-app import is riskier —
  file swap while the DB is open — and stays out of scope.
- Nothing prunes orphaned pictures, so the archive grows with every deleted-
  from-a-page image. Tracked in `plans/pictures-in-bodies.md`; the manifest at
  least now reports them.
