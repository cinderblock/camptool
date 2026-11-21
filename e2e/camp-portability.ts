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
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
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

  // carol: new to B, signs in at A with a passkey (a software key here).
  const carol = await signUp(A, "carol@example.com", "Carol");
  const key = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credId = Buffer.from(randomBytes(16)).toString("base64url");
  {
    const jwk = key.publicKey.export({ format: "jwk" });
    // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
    const cose = Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      Buffer.from(jwk.x as string, "base64url"),
      Buffer.from([0x22, 0x58, 0x20]),
      Buffer.from(jwk.y as string, "base64url"),
    ]);
    const db = new Database(A.db);
    db.run(
      "INSERT INTO membership (id, camp_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'member', 'active', ?)",
      [crypto.randomUUID(), camp.id, carol.id, Date.now()],
    );
    db.run(
      "INSERT INTO passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up) VALUES (?, 'Carol phone', ?, ?, ?, 0, 'singleDevice', 0)",
      [crypto.randomUUID(), cose.toString("base64"), carol.id, credId],
    );
    db.close();
  }

  // --- Target: people already there. ---
  await signUp(B, "owner-b@example.com", "Owner B");
  const aliceB = await signUp(B, "alice@example.com", "Alice (B)");
  const bobB = await signUp(B, "BOB@example.com", "Somebody else");

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
      "B: members are alice (her existing account), carol (new) and a claim placeholder",
      members.length === 3 &&
        members.some((m) => m.email === "carol@example.com") &&
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
      JSON.parse(out?.people ?? "[]").length === 3,
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

  // --- Logins after the move. ---
  const go = (url: string, cookie = "") =>
    fetch(url, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  const loc = (r: Response) => r.headers.get("location") ?? "";

  const anon = await go(`${A.url}/wiki`);
  check(
    "A: a signed-out visitor is pointed at the move page",
    anon.status === 302 && loc(anon).startsWith(`${A.url}/moved/`),
    loc(anon),
  );
  const movedPage = await go(loc(anon));
  check(
    "A: the move page names the new home",
    movedPage.status === 200 &&
      (await movedPage.text()).includes("localhost:17982"),
  );

  const carolHop = await go(`${A.url}/wiki`, carol.cookie);
  const handoff = loc(carolHop);
  check(
    "A: carol, signed in there, is handed to B",
    handoff.startsWith(`${B.url}/move-handoff?t=`),
    handoff,
  );
  const landed = await go(handoff);
  const carolB = cookieOf(landed);
  check(
    "B: the hand-off signs carol in and goes on to the same page",
    landed.status === 302 && !!carolB && loc(landed) === `${B.url}/wiki`,
    `${landed.status} ${loc(landed)}`,
  );
  const replay = await go(handoff);
  check(
    "B: a hand-off works once",
    !cookieOf(replay) && loc(replay).startsWith("/login"),
    loc(replay),
  );
  const forced = await go(`${B.url}/`, carolB);
  check(
    "B: carol must make a passkey here first",
    loc(forced).startsWith("/new-passkey"),
    loc(forced),
  );

  const aliceHop = await go(loc(await go(`${A.url}/`, alice.cookie)));
  check(
    "B: no hand-off into an account that was already here (alice)",
    !cookieOf(aliceHop) && loc(aliceHop).startsWith("/login"),
    loc(aliceHop),
  );

  const bobHop = await go(loc(await go(`${A.url}/`, bob.cookie)));
  const claimUrl = loc(bobHop);
  check(
    "B: bob is sent to claim his place",
    claimUrl.startsWith("/move-claim?c="),
    claimUrl,
  );
  const claimed = await post(B, claimUrl, bobB.cookie, new URLSearchParams());
  check(
    "B: bob claims it with the account he has here",
    claimed.status === 302,
    `HTTP ${claimed.status}`,
  );
  {
    const db = new Database(B.db, { readonly: true });
    const m = db
      .query(
        "SELECT count(*) AS n FROM membership WHERE camp_id = ? AND user_id = ?",
      )
      .get(camp.id, bobB.id) as { n: number };
    const ph = db
      .query(
        "SELECT count(*) AS n FROM user WHERE email LIKE '%@claim.invalid'",
      )
      .get() as { n: number };
    check(
      "B: bob's account is in the camp; the placeholder is gone",
      m.n === 1 && ph.n === 0,
    );
    db.close();
  }

  const wk = await go(`${A.url}/.well-known/webauthn`);
  const wkBody = (await wk.json().catch(() => ({}))) as { origins?: string[] };
  check(
    "A: its passkeys may be used at B (related origins)",
    JSON.stringify(wkBody.origins) === JSON.stringify([B.url]),
    JSON.stringify(wkBody),
  );

  // carol's passkey from A, used directly at B.
  const pk = (body: unknown) =>
    fetch(`${B.url}/api/move-passkey`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: B.url },
      body: JSON.stringify(body),
    });
  const assertion = (challenge: string, origin: string) => {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge, origin }),
    );
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(Math.floor(Date.now() / 1000));
    const authData = Buffer.concat([
      createHash("sha256").update("localhost").digest(),
      Buffer.from([0x05]),
      counter,
    ]);
    const signature = createSign("SHA256")
      .update(
        Buffer.concat([
          authData,
          createHash("sha256").update(clientDataJSON).digest(),
        ]),
      )
      .sign(key.privateKey);
    return {
      id: credId,
      rawId: credId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        authenticatorData: Buffer.from(authData).toString("base64url"),
        clientDataJSON: Buffer.from(clientDataJSON).toString("base64url"),
        signature: Buffer.from(signature).toString("base64url"),
      },
    };
  };
  const loginPage = await (await go(`${B.url}/login`)).text();
  check(
    "B: the login page offers passkeys from the old site",
    loginPage.includes("Use a passkey from") &&
      loginPage.includes(`${A.url}/moved/`),
  );
  const o1 = (await (
    await pk({ step: "options", rpId: "localhost" })
  ).json()) as {
    id: string;
    options: { challenge: string };
  };
  const wrong = await pk({
    step: "verify",
    id: o1.id,
    response: assertion(o1.options.challenge, "http://evil.test"),
  });
  check(
    "B: an old passkey signed for another site is refused",
    wrong.status === 401,
    `HTTP ${wrong.status}`,
  );
  const o2 = (await (
    await pk({ step: "options", rpId: "localhost" })
  ).json()) as typeof o1;
  const good = await pk({
    step: "verify",
    id: o2.id,
    response: assertion(o2.options.challenge, B.url),
  });
  check(
    "B: carol signs in with her passkey from A",
    good.ok && !!cookieOf(good),
    `HTTP ${good.status}`,
  );

  const taken = await post(
    A,
    "/new-camp",
    (await signUp(A, "dora@example.com", "Dora")).cookie,
    new URLSearchParams({ name: "Squatters", slug: "movers" }),
  );
  check(
    "A: the old address is held while it forwards",
    (await taken.text()).includes("moved to another site"),
    `HTTP ${taken.status}`,
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
