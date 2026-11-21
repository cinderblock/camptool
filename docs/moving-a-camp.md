# Moving a camp to another CampTool site

A camp can move between any two CampTool sites: from camptool.org to a server
you run yourself, from your server to camptool.org, between two self-hosted
servers, or back to a site it once left. Everything comes along: members,
maps, pictures, wiki pages, schedules and the rest. Both sites need a CampTool
release that has this feature.

Design and reasoning: [`plans/camp-portability.md`](../plans/camp-portability.md).

## Steps

1. **On the old site**, a camp admin opens **Camp settings → Move this camp**
   and starts the move. The camp becomes **read-only** there (so nothing
   written during the move is lost), and the page shows a **move code**
   (`camptool-move:1:…`). The code works once, for 7 days. Keep it private:
   it unlocks the camp's data.
2. **On the new site**, the same person signs in (or signs up) with the same
   email address and opens **`/import-camp`** ("Bring a camp here"). They paste
   the code and press **Check**. The page shows the camp, warnings, and who
   each person becomes on the new site. Nothing is written yet.
3. They pick the camp's address and press **Import the camp**. The new site
   tells the old one, which **deletes the camp there** and starts forwarding.

Who may import: anyone allowed to start a camp on that site (open camp
creation, a camp setup link via `/import-camp?link=<token>`, or a site
admin), and only one of the camp's own admins (or a site admin). People's
details aren't shown until that's confirmed.

If the new site can't reach the old one (a private network, say), download the
camp as a file from the old site's move page, choose it on `/import-camp`
along with the code, and afterwards finish the move on the old site by giving
the camp's new address.

To call a move off, use **Call off the move** on the old site's move page. The
camp is writable again at once.

## People and sign-ins

**Passwords never leave the old site.** Instead, for a year after the move:

- The old site's links forward to the same page at the new site.
- Signing in at the old site, in any way that worked there, passes the person
  on to the new site already signed in (a one-time token signed with a key
  made for this move; the two sites share no secrets).
- Passkeys from the old site work at the new one directly in browsers that
  support WebAuthn Related Origin Requests (Chrome and Edge 128+, Safari 18+):
  the old site lists the new one at `/.well-known/webauthn`. The new site's
  login page offers "Use a passkey from <old site>".
- Discord sign-in keeps working wherever the new site has Discord set up.

Everyone the move brings in as a new account must **make a passkey** for the
new site the first time they arrive.

How people are matched on the new site:

| Situation | Result |
| --- | --- |
| No account there with their address | A new account, with their passkeys and Discord link |
| An account there that is provably theirs (same Discord account, the same account coming back, or both addresses verified), or the person importing | That account joins the camp. Nothing is added to its sign-ins |
| An account there with their address, but nothing proves it's theirs | Their place is held. They claim it by signing in once at the old site, then signing in to that account |

The old site keeps the camp's address reserved while it forwards. After the
year, forwarding stops and accounts on the old site that are left in no camp
are deleted.

## Things to know

- The new site must be at least as new as the old one. If it's older, the
  import says so: update it first. Updating both to the latest release before
  a move is the simplest rule.
- A camp that uses structure packs the new site doesn't bundle keeps its map
  rows, but those structures don't draw until the site adds the pack.
- A camp's Discord server ID comes along; invite the new site's bot to it.
- Site admins see moves in and out under **Site admin → Camp moves**.
- Moving a whole single-camp server onto a fresh Cloudflare database (with the
  old address pointed at the new deployment) is a different tool:
  `scripts/import-to-d1.ts`, see [`cloudflare-deploy.md`](cloudflare-deploy.md).

## Inspecting a bundle file

```sh
bun scripts/camp-move.ts inspect <file.camptool> <move code>
```

Opens a downloaded bundle with its code and prints what's inside, with a
check of every table's and file's hash and the signature.

## Testing

`bun e2e/camp-portability.ts [bun|cf] [bun|cf]` moves a camp between two
local sites and back, with either side a Bun dev server or the Cloudflare
build under local `wrangler dev` (run `bun run cf:build` first).
