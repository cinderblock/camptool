/**
 * Camp subdomains (plans/hosting-other-camps.md), over real HTTP: each request
 * carries the `Host` a browser on `<slug>.localhost` would send. Checks the
 * cross-domain cookie, reserved slugs, apex → subdomain redirects, the
 * signed-out round trip through the apex login (and that `next` can't be an
 * open redirect), non-members, and an action on a subdomain.
 *
 *   CAMP_SUBDOMAINS=1 DATABASE_PATH=./data/verify/sub.db \
 *     PUBLIC_BASE_URL=http://localhost:17950 PORT=17950 bun run dev
 *   bun e2e/camp-subdomains.ts
 */
const APEX = process.env.E2E_BASE_URL ?? "http://localhost:17950";
const ORIGIN = { origin: APEX };
/** host:port of the apex, to build camp hosts under it. */
const APEX_HOST = new URL(APEX).host;
let ok = 0;
let bad = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) ok++;
  else bad++;
  console.log(
    `${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`,
  );
};
// Talk to the same server, but as a given host (what a browser on
// <slug>.localhost would send).
const asHost = (host: string, path: string, init: RequestInit = {}) =>
  fetch(`${APEX}${path}`, {
    ...init,
    redirect: "manual",
    headers: { ...(init.headers as Record<string, string>), host },
  });

const email = `sub-${Date.now()}@example.com`;
const su = await fetch(`${APEX}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json", ...ORIGIN },
  body: JSON.stringify({ email, password: "verify123456", name: "Sub Host" }),
});
const setCookie = su.headers.getSetCookie();
const cookie = setCookie
  .map((c) => c.split(";")[0])
  .filter((c) => c?.includes("session_token"))
  .join("; ");
check("sign up on the apex", su.ok && !!cookie, `HTTP ${su.status}`);
check(
  "session cookie is set for the apex domain",
  setCookie.some((c) => /session_token/.test(c) && /Domain=localhost/i.test(c)),
  setCookie.join(" | "),
);
const H = { cookie, ...ORIGIN };
const SLUG = `sub${Date.now().toString(36)}`;

const mk = (slug: string) =>
  fetch(`${APEX}/api/auth/organization/create`, {
    method: "POST",
    headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ name: `Camp ${slug}`, slug }),
  });
const bad1 = await mk("www");
check("a reserved slug is refused", bad1.status === 400, `HTTP ${bad1.status}`);
const created = await mk(SLUG);
const org = (await created.json()) as { id?: string };
check("create subcamp", created.ok && !!org.id, `HTTP ${created.status}`);
await fetch(`${APEX}/api/auth/organization/set-active`, {
  method: "POST",
  headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ organizationId: org.id }),
});

const apexMap = await fetch(`${APEX}/settings?x=1`, {
  headers: H,
  redirect: "manual",
});
check(
  "on the apex, a camp page moves to the camp's subdomain",
  apexMap.status === 302 &&
    apexMap.headers.get("location") ===
      `http://${SLUG}.${APEX_HOST}/settings?x=1`,
  `${apexMap.status} → ${apexMap.headers.get("location")}`,
);

const sub = await asHost(`${SLUG}.${APEX_HOST}`, "/settings", {
  headers: H,
});
const subHtml = await sub.text();
check(
  "the subdomain serves the camp",
  sub.status === 200 && subHtml.includes(`Camp ${SLUG}`),
  `HTTP ${sub.status}`,
);

const anon = await asHost(`${SLUG}.${APEX_HOST}`, "/settings");
check(
  "signed out on a subdomain → the apex login, with a way back",
  anon.status === 302 &&
    anon.headers.get("location") ===
      `${APEX}/login?next=${encodeURIComponent(`http://${SLUG}.${APEX_HOST}/settings`)}`,
  `${anon.status} → ${anon.headers.get("location")}`,
);

const back = await fetch(
  `${APEX}/login?next=${encodeURIComponent(`http://${SLUG}.${APEX_HOST}/settings`)}`,
  { headers: H, redirect: "manual" },
);
check(
  "login with a session goes straight back to the camp",
  back.status === 302 &&
    back.headers.get("location") === `http://${SLUG}.${APEX_HOST}/settings`,
  `${back.status} → ${back.headers.get("location")}`,
);

const evil = await fetch(
  `${APEX}/login?next=${encodeURIComponent("https://evil.example/")}`,
  { headers: H, redirect: "manual" },
);
check(
  "login refuses to bounce anywhere else",
  evil.status === 302 && evil.headers.get("location") === "/",
  `${evil.status} → ${evil.headers.get("location")}`,
);

const other = await asHost(`othercamp.${APEX_HOST}`, "/settings", {
  headers: H,
});
check(
  "a camp you're not in → its public page on the apex",
  other.status === 302 &&
    other.headers.get("location") === `${APEX}/c/othercamp`,
  `${other.status} → ${other.headers.get("location")}`,
);

const post = await asHost(`${SLUG}.${APEX_HOST}`, "/settings", {
  method: "POST",
  headers: { ...H, origin: `http://${SLUG}.${APEX_HOST}` },
  body: new URLSearchParams({ feature: "wiki", state: "on" }),
});
check(
  "an action works on the subdomain",
  post.status === 200,
  `HTTP ${post.status}`,
);

console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
