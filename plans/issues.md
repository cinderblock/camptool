# Issues — known concerns, deferred

> Things that are wrong, risky, or unresolved but are **not** being worked on
> right now. Not a feature backlog (that's the roadmap in `plans/camptool.md`)
> and not a task plan — this is where a concern goes so it stops living in
> someone's head. Each entry: what, why it matters, what we'd do, and how
> urgent it actually is.
>
> Plan path: `plans/issues.md`

## Open

### `e2e/prospects.ts` 9g fails: the Members page HTML has no prospect link

**Raised:** multi-host thread, 2026-11-13. **Status:** not investigated.

`E2E_BASE_URL=… bun e2e/prospects.ts` → 37 passed, 1 failed:
`FAIL 9g. Members links the new member back to their recruiting history`.
The test looks for `/prospects/<id>` in the server-rendered `/members` page.
The "Recruiting history" link (`app/routes/dashboard/members.tsx`, ~line 1851)
now lives in the member detail sidebar from `05a494f` (2026-08-20), which isn't
in that HTML. Probably the test is stale rather than the feature broken, but
check that an officer can still reach the thread from Members. 9h (the inverse
check) passes vacuously for the same reason, so it proves nothing right now.

### `sap-pdf.test.ts` fails locally (4 tests)

**Raised:** map-aerial thread, 2026-11-05. **Status:** not investigated.

On Cameron's Windows box with Bun 1.4.2 and a fresh `bun install
--frozen-lockfile`, `bun test` has 4 failures, all in `app/lib/sap-pdf.test.ts`:
`parseSapPdf > reads one pass per page…` ("page 1 did not parse"), and three
`sliceSapPage` cases where `scanCodesInPdf` finds 0 QR codes where 1 is
expected. Every other suite passes (437). Untouched by the commit that noticed
it. **Why it matters:** the SAP slice/scan code guards against a pass leaking
another person's QR code; a red suite hides a real regression there. Could be
the Bun version (the plan records 1.3.0) or a QR/PDF dependency behaving
differently on Windows.

### The public programming schedule exposes the server to the open internet

**Raised:** Cameron, 2026-08-16. **Status:** deferred, "that's for later".

`/c/:slug/schedule` serves the camp's programming lineup with no auth, and
`/c/:slug` does the same for recruiting. The recruiting page is fine and stays
public — strangers applying is the entire point of it. The schedule is the
uncomfortable one:

> "the schedule probably shouldn't [be public]… i don't want the internet
> hammering this server publicly."

**Why it matters.** This is a single small self-hosted Bun server on firefly
holding every camp's data. An unauthenticated, linkable, crawlable page is an
open invitation: search engines index it, a flyer QR code can put it in front of
a crowd, and there is no rate limiting, no CDN, and no cache in front of it. The
page also runs real DB queries per request. Note this is a *capacity and
exposure* worry, not a data-leak one — the page only renders offerings that were
deliberately scheduled and not marked camp-only.

**Options when we pick this up**, cheapest first:

1. **Turn it off.** The feature flag already gates it: Programming set to
   anything but fully `on` makes the public page 404. Zero code.
2. **Static/cached rendering.** Cache the rendered lineup and serve it from
   memory or disk with a short TTL, so hammering costs ~nothing per hit.
3. **Unguessable URL.** Serve it at a per-edition random token instead of the
   camp slug, so it's shareable-by-link but not enumerable or crawlable.
4. **Put a CDN in front of it** (Cloudflare). Effective, but drags the whole
   deployment into infrastructure that is deliberately off-limits without
   per-change authorization — so it is not the cheap answer it looks like.
5. **Export instead of serve.** Generate a static page/PDF the camp hosts
   anywhere else. Fully removes CampTool from the public path.

**Recommendation when revisited:** (2) + (3) together — keeps the "flyer with a
QR code" use case that the feature was built for, while making the page cheap to
serve and impossible to enumerate. (1) is the correct immediate lever if it ever
actually gets hammered.

**Related:** `plans/camptool.md` locked decision #0 (private-first — nothing
publishes directly from CampTool; these two pages are the named exceptions),
`plans/programming-offerings.md`.
