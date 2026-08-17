# Pictures in wiki pages and FAQ answers

> Task plan. Parent living plan: `plans/camptool.md` (read that first).
> Siblings: `plans/camp-wiki.md`, `plans/camp-faq.md` — the two surfaces this
> serves. Plan path: `plans/pictures-in-bodies.md`

## Goal (user ask, 2026-08-17)

> "faq and wiki both need to support pictures"

Both already share one body format (`app/lib/wiki.ts`) and one editor
(`app/components/MarkupTextarea.tsx`), so this is **one implementation that
lands in both** — not two features. That shared seam is the reason this is
cheap; keep it that way.

This supersedes the open question in `plans/camp-wiki.md` ("Attachments/images
— out of scope for now, no storage infra"). There is storage infra now.

## Decisions already made (don't re-ask)

Asked and answered by Cameron, 2026-08-17, before any code:

1. **Bytes live on disk in the existing data dir**, next to the SQLite file —
   `dirname(DATABASE_PATH)/uploads/`, overridable with `UPLOADS_PATH`. On
   firefly that is `/srv/camptool/data/uploads/`, which already exists and
   survives deploys, so **no ops change is needed**. Only the metadata row
   lives in SQLite.

   *Superseded:* an earlier answer in this same conversation picked SQLite
   blobs; Cameron reversed it on learning the data dir already existed. Don't
   re-litigate — but do carry the consequence below.

2. **Originals are kept at full resolution.** Nothing downscales the file that
   gets stored. A camp photo is an archive, not just a page illustration.

3. **External image URLs are allowed too.** A member can paste an `https://…`
   image URL instead of uploading. Accepted cost: loading the page tells that
   host the reader's IP, and the image can rot. Mitigated with
   `referrerPolicy="no-referrer"` and by making upload the easy path.

Decided here:

4. **A display variant is generated in the browser, and the original is still
   stored.** Full-res honours decision 2, but inlining a 12 MP phone photo on a
   playa-grade connection is not acceptable, so the upload sends *two* files:
   the untouched original and a max-1600px WebP made with `createImageBitmap` +
   canvas. Pages render the display copy and link to the original. No native
   image dependency (`sharp`) enters the repo, and the server never transforms
   bytes. If a browser can't produce the variant, the original is served.
5. **No SVG.** It is scriptable. The allowlist is PNG / JPEG / GIF / WebP, and
   the stored type comes from **sniffing magic bytes**, never from the
   browser's claim.
6. **Serving is auth-gated and camp-scoped** — `/media/:id` inside the app, not
   a static path. Private-first: an image is camp data like any other row.
   A cross-camp id must 404, and that is an e2e assertion, not a comment.

### Consequence to carry: `/export-db` is no longer a complete backup

The whole-DB download now captures every image's *metadata* and none of its
*bytes*. That is a real regression in a feature the deployment owner relies on,
and the fix is not "remember it" — the copy on the Site admin page and
`docs/firefly-deploy.md` must both say so, pointing at the uploads dir as the
second thing to back up. Doing that is part of this task, not a follow-up.

## Design

### Schema — `db/schema/image.ts`, one table

`camp_image`: id, campId, filename, mimeType, byteSize, width?, height?,
displayMimeType?, displayByteSize?, uploadedById?, createdAt.
Index `(camp_id, created_at)`.

No bytes column — the row is the metadata, the file is on disk at
`<uploads>/<camp_id>/<id>` (plus `<id>.display` when there is a variant). The
camp id is a directory level so a camp's pictures can be moved or removed as a
unit, and so one directory never accumulates every camp's files.

CAMP-scoped, deliberately not tied to a page or an answer: the same photo of
the shade structure belongs in a wiki page *and* an FAQ answer, and a picture
should outlive the body that first used it.

**Filenames are never taken from user input.** The path is built from the
camp id and a generated uuid; the original filename is metadata only (it is
what the download is named). That is the whole path-traversal defence.

### Markup — one new inline node

Standard markdown image syntax, because it is the one spelling everybody
already knows and the body is already a markdown subset:

- `![Shade structure](/media/<id>)` — an upload
- `![Playa map](https://…)` — external

`src` is **validated at render time**, not just at write time: only
`/media/<uuid>` or `http(s)://` produce an `<img>`. Anything else (`javascript:`,
`data:`, a relative path) degrades to its alt text. The body is member-authored
and this is a multi-tenant SSR process — the same rule that keeps
`dangerouslySetInnerHTML` out of this codebase applies to `src`.

A paragraph containing **only** an image renders as a block figure (with the
alt text as a caption); otherwise the image is inline. That gets "a photo on
its own line looks like a photo" without a second syntax.

### Serving — `/media/:id` (display) and `/media/:id/full` (original)

Resource route outside the app shell. `requireActiveCamp`, then the row must
belong to the **active camp**. The body is a stream off disk, never a read of
the whole file into memory — originals are full-res and can be tens of MB.
Responses carry:

- `Content-Type` from the **sniffed** type stored at upload
- `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src
  'none'` — an uploaded file should never be interpretable as a document
- `Cache-Control: private, max-age=31536000, immutable` — bytes at an id never
  change, and `private` keeps shared caches out of camp data
- `Content-Disposition: inline` with the original filename on `/full`

### Upload — `POST /api/media`

Multipart, two parts: `file` (the untouched original) and optional `display`
(the browser's WebP variant). Who may upload is derived from who may *write*
something that takes a picture: member+ where the wiki is visible, officer+
where the FAQ is. A recruit never can. Server-side: allowlisted sniffed type
and a hard **25 MB** cap on the original — generous, because full-res is the
point, but not unbounded.

### Editor

`MarkupTextarea` gains one "Add a picture" control feeding three paths into the
same upload function — **file picker, paste, and drag-and-drop onto the
textarea**. Paste and drop are what make it usable on a laptop; they cost one
shared handler. On success the `![alt](/media/id)` snippet lands at the cursor.

## Phases

1. Schema + migration + `app/lib/images.ts` (pure: sniffing, src validation,
   reference extraction) + `images.server.ts` (disk I/O) + unit tests.
2. Parser + `WikiBody` rendering (safe src, figure-vs-inline) + tests.
3. `/media/:id`, `/media/:id/full`, `/api/media` routes.
4. `MarkupTextarea`: picker + paste + drop + browser-side display variant.
5. Backup honesty: Site admin copy + `docs/firefly-deploy.md` + `.env.example`.
6. Typecheck / lint / test / build, e2e (incl. **cross-camp isolation** and a
   rejected non-image), README + plans, commit.

## Things not to do

- Don't accept SVG, and don't trust the browser's declared MIME type.
- Don't serve images from a public/static path — private-first.
- Don't add a second markup for images; extend the shared body format so both
  surfaces get it at once.
- Don't add a native image dependency (`sharp`) to resize server-side.
- Don't let an unvalidated `src` reach an `<img>`.
- Don't build a disk path from anything the user typed — camp id + uuid only.
- Don't downscale the stored original. The display copy is an *extra*, never a
  replacement (locked decision 2).
- Don't leave `/export-db` describing itself as a complete backup.

## Known gap, deliberately not built yet

**Orphaned images.** Nothing deletes an image when the body referencing it is
edited to drop it. With blobs in the DB that grows the backup forever. A
cheap correct sweep exists (scan every wiki body + FAQ answer for
`/media/<id>` — a camp has dozens, not millions), so the fix is a small
officer-only "unused pictures" list. Tracked here rather than pretended away.

## Progress log

- [x] 2026-08-17 — plan written; storage answered (SQLite blobs), then
      **reversed to the data dir + full-res originals** mid-task.
- [x] Phase 1 — `db/schema/image.ts` (`camp_image`, metadata only), migration
      **`0073_yielding_doorman`**, `app/lib/images.ts` (magic-byte sniffing,
      `resolveImageSrc`, `imageRefs`) + `images.server.ts` (disk I/O, streaming
      `serveImage`, `unusedImageIds`). 25 unit tests in `images.test.ts`.
- [x] Phase 2 — `image` inline node in the shared parser (ordered above the
      bare-URL autolinker), `loneImage()` for the figure case, `<Picture>` in
      `WikiBody` validating every src at render.
- [x] Phase 3 — `/media/:id`, `/media/:id/full`, `POST /api/media`; upload
      rights derived from wiki/FAQ write rights.
- [x] Phase 4 — `MarkupTextarea`: file picker + paste + drop through one
      `uploadPictures()`; `images.client.ts` makes the display copy.
- [x] Phase 5 — backup honesty landed in three places: the Site admin card,
      `docs/firefly-deploy.md` (new "two things, not one" section) and
      `.env.example` (`UPLOADS_PATH`).
- [x] Phase 6 — typecheck + lint + build green; 223/223 unit tests;
      `db:verify` 74 migrations / 63 tables; **`e2e/pictures.ts` 17/17**, with
      `e2e/faq.ts` 34/34 and `e2e/wiki.ts` 17/17 re-run after the renderer and
      editor changes. Dev-server log grepped clean (see the SSR-200 trap below).

### Traps hit, worth keeping

- **The privacy-coverage test caught the new routes**, exactly as designed: a
  loader that doesn't call `redact()` fails the suite until it is listed as
  exempt *with a reason*. Both `/media` routes stream bytes and have no payload
  to walk, and that is now written down in `privacy-coverage.test.ts`.
- **Two e2e assertions were wrong, not the app.** React's SSR emits
  `referrerPolicy` with the DOM property's casing, not lowercase; and the raw
  body — hostile `src` included — legitimately appears in React Router's
  serialized loader payload as a JSON string, so `!html.includes("javascript:")`
  is not the check. Assert `!/src="javascript:/i` instead.
- The bare-URL autolinker would have eaten `(https://…)` out of
  `![alt](https://…)`; the image matcher has to be tried before it. Covered by
  a named regression test.
