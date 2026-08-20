/**
 * End-to-end check of the bins STOCK pull (plans/bins-integration.md phase 2),
 * against a stub bins instance stood up in-process.
 *
 * Three things only an integration test can prove:
 *   - the read token is actually sent to bins as `Authorization: Bearer …`
 *   - and never reaches the browser
 *   - a warehouse that is down, or answers 401, leaves Supplies working
 *
 * That last one is the whole risk of coupling two apps at runtime: the failure
 * mode must be "no panel", never "no supplies page".
 *
 *   DATABASE_PATH=./data/verify/binsstock.db PUBLIC_BASE_URL=http://localhost:17928 \
 *     PORT=17928 bun run dev
 *   E2E_BASE_URL=http://localhost:17928 bun e2e/bins-stock.ts
 */
import { eq } from "drizzle-orm";
import { setBinsLink } from "../app/lib/bins.server";
import { setFeatureState } from "../app/lib/features.server";
import { db } from "../db/client.server";
import {
  camp,
  campEdition,
  inventoryCategory,
  inventoryItem,
  membership,
  user,
} from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17928";
const STAMP = Date.now();
const PW = "bins-stock-pw-1";
const TOKEN = `bins_stub_${STAMP}`;
const STUB_PORT = 17938;
const STUB_URL = `http://localhost:${STUB_PORT}`;

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------- stub bins */

let seenAuth: string | null = null;
let mode: "ok" | "unauthorized" = "ok";

const stub = Bun.serve({
  port: STUB_PORT,
  fetch(req) {
    const url = new URL(req.url);
    seenAuth = req.headers.get("authorization");
    if (mode === "unauthorized") {
      return new Response(JSON.stringify({ error: "nope" }), { status: 401 });
    }
    if (url.pathname === "/api/v1/bins") {
      return Response.json({
        bins: [
          {
            id: 12,
            name: "Gaff tape and zip ties",
            status: "active",
            locationName: "Storage unit",
            externalLabel: null,
            labelIds: [],
          },
          {
            id: 34,
            name: "Kitchen — pots",
            status: "active",
            locationName: "Garage",
            externalLabel: null,
            labelIds: [],
          },
        ],
      });
    }
    if (url.pathname === "/api/v1/locations") {
      return Response.json({ locations: ["Storage unit", "Garage"] });
    }
    return new Response("not found", { status: 404 });
  },
});

/* ------------------------------------------------------------------ seed */

async function account(tag: string) {
  const email = `stock-${tag}-${STAMP}@example.com`;
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Stock ${tag}`, email, password: PW }),
  });
  if (!res.ok) throw new Error(`sign-up failed for ${tag}`);
  const cookie = (res.headers.getSetCookie() ?? [])
    .map((c) => c.split(";")[0])
    .filter((c) => c?.includes("session_token"))
    .join("; ");
  const [u] = await db.select().from(user).where(eq(user.email, email));
  if (!u) throw new Error("no user row");
  return { id: u.id, cookie };
}

const get = (path: string, cookie: string) =>
  fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });

console.log(`\nbins stock e2e → ${BASE} (stub bins on ${STUB_URL})\n`);

const officer = await account("officer");
const campId = crypto.randomUUID();
await db.insert(camp).values({
  id: campId,
  name: `Stock Camp ${STAMP}`,
  slug: `stock-${STAMP}`,
});
await db.insert(campEdition).values({
  id: crypto.randomUUID(),
  campId,
  year: 2026,
  label: "2026",
});
const mid = crypto.randomUUID();
await db.insert(membership).values({
  id: mid,
  organizationId: campId,
  userId: officer.id,
  role: "officer",
  wizardStep: 1,
});
for (const key of ["supplies", "bins"] as const) {
  await setFeatureState({
    campId,
    key,
    state: "on",
    updatedByMembershipId: mid,
  });
}

const categoryId = crypto.randomUUID();
await db.insert(inventoryCategory).values({
  id: categoryId,
  campId,
  name: "Build",
});
const editionRow = await db
  .select({ id: campEdition.id })
  .from(campEdition)
  .where(eq(campEdition.campId, campId));
await db.insert(inventoryItem).values({
  id: crypto.randomUUID(),
  campId,
  editionId: editionRow[0]?.id ?? null,
  categoryId,
  // Deliberately the plain thing a camp would actually type. It has to find
  // the "Gaff tape and zip ties" box with nobody configuring a mapping.
  name: "Gaff tape",
  quantity: 1,
});

/* ----------------------------------------------------------------- tests */

// 1. Address but no read token: the hand-off still works, but there is nothing
//    to read, so Supplies looks exactly as it always did.
await setBinsLink({
  campId,
  baseUrl: STUB_URL,
  accessCode: "join-code",
  apiToken: null,
  label: null,
  updatedByMembershipId: mid,
});
const noToken = await (await get("/supplies", officer.cookie)).text();
check("1. supplies renders", noToken.includes("Camp supplies"));
check(
  "1b. without a token there is no storage panel",
  !noToken.includes("In storage"),
);

// 2. With a token, the panel appears and carries the stock.
await setBinsLink({
  campId,
  baseUrl: STUB_URL,
  accessCode: "join-code",
  apiToken: TOKEN,
  label: null,
  updatedByMembershipId: mid,
});
const withToken = await (await get("/supplies", officer.cookie)).text();
check("2. the storage panel appears", withToken.includes("In storage"));
check("2b. it counts the boxes", withToken.includes("2 boxes"));
check(
  "2c. the stock is on the page, so search works offline of bins",
  withToken.includes("Gaff tape and zip ties"),
);
check(
  "2d. a supply line finds its box by name, with no mapping configured",
  withToken.includes("in Gaff tape and zip ties"),
);
check(
  "3. bins was called with the token as a bearer",
  seenAuth === `Bearer ${TOKEN}`,
  String(seenAuth),
);
check(
  "3b. THE ONE THAT MATTERS: the token is not in the page",
  !withToken.includes(TOKEN),
);

// 4. A warehouse that rejects us must not break the page. Rotate the token as
//    well as flipping the stub: the cache is keyed by credentials, and with the
//    OLD token still valid the server would rightly serve its recent snapshot
//    (stale beats empty for a transient blip — a deliberate choice). Rotating
//    gives a cold key, which is the path being tested here.
mode = "unauthorized";
await setBinsLink({
  campId,
  baseUrl: STUB_URL,
  accessCode: "join-code",
  apiToken: `${TOKEN}-rotated`,
  label: null,
  updatedByMembershipId: mid,
});
const rejected = await get("/supplies", officer.cookie);
const rejectedBody = await rejected.text();
check(
  "4. a 401 from bins leaves supplies working",
  rejected.status === 200 && rejectedBody.includes("Camp supplies"),
  `HTTP ${rejected.status}`,
);
check("4b. and simply omits the panel", !rejectedBody.includes("In storage"));

// 5. Same when bins is not running at all.
mode = "ok";
await setBinsLink({
  campId,
  baseUrl: "http://localhost:17939", // nothing listening
  accessCode: "join-code",
  apiToken: TOKEN,
  label: null,
  updatedByMembershipId: mid,
});
const down = await get("/supplies", officer.cookie);
const downBody = await down.text();
check(
  "5. a warehouse that is down leaves supplies working",
  down.status === 200 && downBody.includes("Camp supplies"),
  `HTTP ${down.status}`,
);

stub.stop(true);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
