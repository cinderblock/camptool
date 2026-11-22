# End-to-end scripts

Each file here drives a running CampTool over HTTP (or a real browser through
Playwright) and checks the result. Its header comment says how to start the
server it expects and how to run it. Browser scripts run under
`node --experimental-strip-types` (Playwright hangs under Bun); the rest run
under `bun`.

## Driving the app as a signed-in user

Use this to look at a page locally, not just unit-test it.

**Run the Bun dev server against a throwaway database**, never the shared dev
one:

```sh
DATABASE_PATH=./data/verify/x.db PUBLIC_BASE_URL=http://localhost:17934 PORT=17934 bun run dev
```

`bun run dev` uses a SQLite file through `bun:sqlite`; Cloudflare's D1 is only
used by `cf:dev` / `cf:preview` (a local D1 under `.wrangler/`, written with
`wrangler d1 execute`; see `cloudflare-smoke.ts`). Everything below is about
the Bun dev server. Without the `DATABASE_PATH` override, test sign-ups land in
`data/camptool.db`, and editing the map writes `map_snapshot` rows there too.

To start from a copy of the dev database, copy it with SQLite's
`VACUUM INTO 'data/verify/x.db'`, never `cp`: it runs in WAL mode, so a plain
copy drops whatever is still in the `-wal` file and can come up with whole
tables missing.

**Get a session by signing up over HTTP.** Password sign-up is off by default
(`instance_setting.allow_password_login`, passkey-first since migration 0096),
so turn it on in the throwaway database first: `setInstanceSettings` in
`password-reset.ts` or the SQL in `passkey-nag.ts`. Then:

```sh
curl -s -D - -H "Expect:" -H "Origin: $BASE" -H "Content-Type: application/json" \
  -d '{"email":"x@test.local","password":"verify123","name":"X"}' \
  "$BASE/api/auth/sign-up/email"
```

The `set-cookie` it returns is the ready-to-use `token.signature` value. To put
the user in an existing camp, insert a `membership` row with that camp's id, a
role, and a non-zero `wizard_step`: non-officers with `wizard_step = 0` are sent
to `/start` from every dashboard page (`app/routes/dashboard/layout.tsx`).

**The cookie name depends on `PUBLIC_BASE_URL`.** `app/lib/auth.server.ts` adds
the `camptool` prefix only when that host is localhost; otherwise it's
`__Secure-better-auth.session_token`. Read it from
`(await auth.$context).authCookies.sessionToken.name` rather than guessing.

**Forging a session instead** (no sign-up): sign the token with better-auth's
own `makeSignature(token, secret)` from `better-auth/crypto` (standard base64
with padding, not base64url), use `` `${token}.${sig}` `` URL-encoded as the
cookie value, and insert a matching `session` row (`token`, `expires_at`,
`user_id`, `active_camp_id`). A raw token with no signature is silently
rejected with a 302 to `/login`, which looks exactly like a wrong cookie name.

**Driving the UI:** use Playwright, whose `ctx.addCookies()` sets the session
cookie (browser extensions that drive your own Chrome generally can't). Browser
scripts take `E2E_BASE_URL` and `E2E_COOKIE='<name>=<value>'`; copy the
bootstrap from `noc-uplink.ts`. A `__Secure-` cookie works on
`http://localhost`, which counts as a secure origin. Keep scratch scripts inside
the repo so they resolve `playwright` and the app's other dependencies.

**Clean up afterwards:** the throwaway user, its `account` / `session` /
`membership` rows, and anything the run created. `bun:sqlite` connections start
with foreign keys off (the app turns them on itself), so an ad-hoc cleanup
script must run `PRAGMA foreign_keys = ON` first and finish with
`PRAGMA foreign_key_check`, or deleting a user or membership leaves dangling
`passkey`, `session` and `map_snapshot` references. Stop the dev server by the PID holding its
port, not `pkill bun`, which hits other work.

## Scripting route actions with curl

Add `-H "Expect:"` to every `curl -d` POST at a route action. Without it curl
may send `Expect: 100-continue`, the body never reaches Bun, and
`request.formData()` throws `ERR_FORMDATA_PARSE_ERROR`. The route returns 500
even though the write already landed, and it's intermittent. better-auth also
wants an `Origin` header:

```sh
curl -H "Origin: $BASE" -H "Expect:" -b cookies.txt -c cookies.txt \
  -X POST "$BASE/programming" -d intent=propose -d title="..."
```

Confirm writes against the database rather than trusting the HTTP status.
