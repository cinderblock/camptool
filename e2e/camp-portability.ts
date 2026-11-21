/**
 * Moving a camp between two CampTool installs over real HTTP
 * (plans/camp-portability.md). Starts two Bun dev servers, each with its own
 * database, uploads and secret, and moves a camp from one to the other:
 *
 *   A (source)  alice runs "Movers"; bob is a member; a picture.
 *   B (target)  already has people: its own first user, alice (the same
 *               address, signed up here too), and someone else using bob's
 *               address.
 *
 *   bun e2e/camp-portability.ts
 *
 * Logs: data/portability/{a,b}.log (grep them for SSR errors: a throw in a
 * loader can still come back as HTTP 200).
 */
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const ROOT = "data/portability";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

let ok = 0;
let bad = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) ok++;
  else bad++;
  console.log(
    `${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`,
  );
};

type Site = {
  name: string;
  url: string;
  db: string;
  uploads: string;
  proc?: Subprocess;
};
const site = (name: string, port: number): Site => ({
  name,
  url: `http://localhost:${port}`,
  db: join(ROOT, `${name}.db`),
  uploads: join(ROOT, `${name}-uploads`),
});
const A = site("a", 17981);
const B = site("b", 17982);

async function start(s: Site) {
  const log = Bun.file(join(ROOT, `${s.name}.log`));
  s.proc = Bun.spawn(["bun", "--bun", "react-router", "dev"], {
    env: {
      ...process.env,
      PORT: new URL(s.url).port,
      PUBLIC_BASE_URL: s.url,
      DATABASE_PATH: s.db,
      UPLOADS_PATH: s.uploads,
      BETTER_AUTH_SECRET: `secret-${s.name}-${"x".repeat(40)}`,
      CAMP_SUBDOMAINS: "",
      LEGACY_HOSTS: "",
    },
    stdout: log,
    stderr: log,
  });
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${s.url}/login`);
      if (r.status < 500) return;
    } catch {}
    await Bun.sleep(1000);
  }
  throw new Error(`${s.name} didn't start`);
}

const cookieOf = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] as string)
    .filter((c) => /session_token=/.test(c))
    .join("; ");

async function signUp(s: Site, email: string, name: string) {
  const r = await fetch(`${s.url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: s.url },
    body: JSON.stringify({ email, password: "verify123456", name }),
  });
  const cookie = cookieOf(r);
  if (!r.ok || !cookie) throw new Error(`sign-up on ${s.name}: ${r.status}`);
  const me = (await r.json()) as { user: { id: string } };
  return { cookie, id: me.user.id };
}

const post = (s: Site, path: string, cookie: string, body: BodyInit) =>
  fetch(`${s.url}${path}`, {
    method: "POST",
    headers: { cookie, origin: s.url },
    body,
    redirect: "manual",
  });

// biome-ignore format: a 1x1 PNG
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

try {
  await start(A);
  await Bun.sleep(3000); // two dev servers racing on typegen trip over each other
  await start(B);

  // --- Source: a camp with two people and a picture. ---
  await signUp(A, "owner-a@example.com", "Owner A"); // first user: site admin
  const alice = await signUp(A, "alice@example.com", "Alice");
  const H = {
    "content-type": "application/json",
    cookie: alice.cookie,
    origin: A.url,
  };
  const oc = await fetch(`${A.url}/api/auth/organization/create`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: "Movers", slug: "movers" }),
  });
  const camp = (await oc.json()) as { id: string };
  check("A: alice makes the camp", oc.ok, `HTTP ${oc.status}`);
  await fetch(`${A.url}/api/auth/organization/set-active`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ organizationId: camp.id }),
  });
  await post(
    A,
    "/settings",
    alice.cookie,
    new URLSearchParams({ feature: "wiki", state: "on" }),
  );
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/png" }), "dot.png");
  const up = await post(A, "/api/media", alice.cookie, fd);
  check("A: upload a picture", up.ok, `HTTP ${up.status}`);
  const bob = await signUp(A, "bob@example.com", "Bob");
  {
    const db = new Database(A.db);
    db.run(
      "INSERT INTO membership (id, camp_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'member', 'active', ?)",
      [crypto.randomUUID(), camp.id, bob.id, Date.now()],
    );
    db.close();
  }

  // --- Target: people already there. ---
  await signUp(B, "owner-b@example.com", "Owner B");
  const aliceB = await signUp(B, "alice@example.com", "Alice (B)");
  await signUp(B, "BOB@example.com", "Somebody else");

  // --- Start the move on A. ---
  const start1 = await post(
    A,
    "/move",
    alice.cookie,
    new URLSearchParams({ intent: "start", understood: "on" }),
  );
  check("A: start the move", start1.status < 400, `HTTP ${start1.status}`);
  const page = await (
    await fetch(`${A.url}/move`, { headers: { cookie: alice.cookie } })
  ).text();
  const code =
    page.match(/camptool-move:1:[^<"\s]+/)?.[0]?.replaceAll("&amp;", "&") ?? "";
  check(
    "A: the move page shows the code",
    code.startsWith("camptool-move:1:http://localhost:17981:"),
  );
  const frozen = await post(
    A,
    "/settings",
    alice.cookie,
    new URLSearchParams({ feature: "wiki", state: "off" }),
  );
  check(
    "A: the camp is read-only while moving",
    frozen.status === 423,
    `HTTP ${frozen.status}`,
  );

  // --- Import on B. ---
  const checkRes = await post(
    B,
    "/import-camp",
    aliceB.cookie,
    new URLSearchParams({ intent: "check", code }),
  );
  const checkHtml = await checkRes.text();
  check(
    "B: the check lists the camp",
    checkHtml.includes("Movers") && checkHtml.includes("Import the camp"),
    `HTTP ${checkRes.status}`,
  );
  check(
    "B: alice is recognised as herself",
    checkHtml.includes("You, importing the camp."),
  );
  check(
    "B: bob's address is a claim, not a merge",
    checkHtml.includes("Must claim"),
  );

  const imp = await post(
    B,
    "/import-camp",
    aliceB.cookie,
    new URLSearchParams({ intent: "import", code, slug: "movers" }),
  );
  const impHtml = await imp.text();
  check("B: import", impHtml.includes("Movers is here"), `HTTP ${imp.status}`);
  check(
    "B: A was told",
    !impHtml.includes("couldn&#x27;t be told") &&
      !impHtml.includes("couldn't be told"),
  );

  // --- Results. ---
  {
    const db = new Database(B.db, { readonly: true });
    const members = db
      .query(
        "SELECT u.email, m.role FROM membership m JOIN user u ON u.id = m.user_id WHERE m.camp_id = ? ORDER BY u.email",
      )
      .all(camp.id) as { email: string; role: string }[];
    check(
      "B: members are alice (her existing account) and a claim placeholder",
      members.length === 2 &&
        members.some(
          (m) => m.email === "alice@example.com" && m.role === "admin",
        ) &&
        members.some((m) => m.email.endsWith("@claim.invalid")),
      JSON.stringify(members),
    );
    const accounts = db
      .query("SELECT count(*) AS n FROM account WHERE user_id = ?")
      .get(aliceB.id) as { n: number };
    check("B: nothing added to alice's account", accounts.n === 1);
    const moveIn = db
      .query("SELECT source_origin FROM camp_move_in WHERE camp_id = ?")
      .get(camp.id) as { source_origin: string } | null;
    check("B: the move is recorded", moveIn?.source_origin === A.url);
    const pics = db
      .query("SELECT count(*) AS n FROM camp_image WHERE camp_id = ?")
      .get(camp.id) as { n: number };
    check("B: the picture's row came", pics.n === 1);
    db.close();
    const files = [...new Bun.Glob(`${camp.id}/*`).scanSync(B.uploads)];
    check("B: the picture's files came", files.length >= 1, files.join(","));
  }
  {
    const db = new Database(A.db, { readonly: true });
    const left = db
      .query("SELECT count(*) AS n FROM camp WHERE id = ?")
      .get(camp.id) as { n: number };
    check("A: the camp is deleted", left.n === 0);
    const out = db
      .query("SELECT state, target_origin, people FROM camp_move_out")
      .get() as { state: string; target_origin: string; people: string } | null;
    check(
      "A: the move is done and points at B",
      out?.state === "done" && out.target_origin === B.url,
    );
    check(
      "A: it remembers the camp's people",
      JSON.parse(out?.people ?? "[]").length === 2,
    );
    db.close();
    const files = [
      ...new Bun.Glob(`${camp.id}/*`).scanSync({
        cwd: A.uploads,
        onlyFiles: true,
      }),
    ];
    check("A: the camp's files are deleted", files.length === 0);
  }
  const again = await post(
    B,
    "/import-camp",
    aliceB.cookie,
    new URLSearchParams({ intent: "check", code }),
  );
  check(
    "B: the code is used up",
    (await again.text()).includes("doesn"),
    `HTTP ${again.status}`,
  );
} catch (e) {
  bad++;
  console.error(e);
} finally {
  A.proc?.kill();
  B.proc?.kill();
}
console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
