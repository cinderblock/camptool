/**
 * End-to-end check of Setup Access Pass import, assignment and release
 * (plans/sap-import-and-distribution.md), over real HTTP.
 *
 * The assertions that matter most are the ones a unit test can't reach, because
 * they're about who gets to see a secret through a real request:
 *   - importing a real multipart upload creates stock, and re-uploading the
 *     same order imports nothing the second time
 *   - a PDF for the wrong year is refused rather than imported mis-dated
 *   - ASSIGNED reveals nothing. Not on the page, not via the download route,
 *     not even to an officer. This is the whole point of the state existing.
 *   - RELEASED reveals the codes to the holder — and to nobody else
 *   - the released PDF carries exactly ONE pass's QR code, which is the defect
 *     the camp's hand-cut files had
 *   - release is one-way: unassigning a released pass is refused
 *   - voiding needs admin AND a reason, and does NOT return the pass to stock
 *   - the group sheet refuses an id the viewer isn't entitled to, rather than
 *     quietly dropping it from the sheet
 *
 * No browser needed, so this runs under bun.
 *
 *   DATABASE_PATH=./data/verify/sap.db \
 *     PUBLIC_BASE_URL=http://localhost:17932 PORT=17932 bun run dev
 *   E2E_BASE_URL=http://localhost:17932 bun e2e/sap-passes.ts
 */
import bwipjs from "bwip-js/node";
import { and, eq } from "drizzle-orm";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { outstandingAsks } from "../app/lib/asks";
import { loadAskSnapshots } from "../app/lib/asks.server";
import { ensureMemberAttendee } from "../app/lib/attendee.server";
import { setFeatureState } from "../app/lib/features.server";
import {
  scanCodesInEmbeddedImages,
  scanCodesInPdf,
} from "../app/lib/sap-qr.server";
import { db } from "../db/client.server";
import {
  attendee,
  camp,
  campEdition,
  membership,
  setupPass,
  setupPassStock,
  user,
} from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17932";
const STAMP = Date.now();
const PW = "sap-tester-pw-1";
const YEAR = 2026;

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

async function account(tag: string): Promise<{ id: string; cookie: string }> {
  const email = `sap-${tag}-${STAMP}@example.com`;
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `SAP ${tag}`, email, password: PW }),
  });
  if (!signUp.ok) throw new Error(`sign-up failed for ${tag}`);
  const cookie = (signUp.headers.getSetCookie() ?? [])
    .map((c) => c.split(";")[0])
    .filter((c) => c?.includes("session_token"))
    .join("; ");
  const [u] = await db.select().from(user).where(eq(user.email, email));
  if (!u) throw new Error(`no user row for ${tag}`);
  return { id: u.id, cookie };
}

const get = (path: string, cookie: string) =>
  fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });

const post = (path: string, cookie: string, fields: Record<string, string>) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });

/** Upload a PDF the way the browser does. */
async function upload(cookie: string, bytes: Uint8Array, name: string) {
  const body = new FormData();
  body.set("intent", "importPasses");
  body.set(
    "file",
    new File([new Uint8Array(bytes)], name, { type: "application/pdf" }),
  );
  return fetch(`${BASE}/passes`, {
    method: "POST",
    headers: { cookie },
    body,
    redirect: "manual",
  });
}

/** A synthetic vendor order. Invented codes — a real pass must never be in a
 * repo or a test fixture. Every page's resources list every QR, which is the
 * vendor structure and the reason slicing has to prune. */
async function buildOrder(
  year: number,
  passes: { ticket: string; scan: string; date: string; sec: string }[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const qrs = [];
  for (const p of passes) {
    const png = await bwipjs.toBuffer({
      bcid: "qrcode",
      text: p.scan,
      scale: 3,
      backgroundcolor: "FFFFFF",
    });
    qrs.push(await doc.embedPng(new Uint8Array(png)));
  }
  for (const [i, p] of passes.entries()) {
    const page = doc.addPage([612, 792]);
    const line = (t: string, y: number, size = 10) =>
      page.drawText(t, { x: 55, y, size, font });
    line(`Ticket ID ${p.ticket}`, 700);
    line("Confirmation Id", 685);
    line("1ZZZZZZ000000000", 670);
    line(`Placement Setup Pass (SAP) ${p.date} & Later`, 655);
    line(`Black Rock City: Access ${year}`, 640);
    line(`Security code: ${p.sec}`, 50, 8);
    const own = qrs[i];
    if (own) page.drawImage(own, { x: 400, y: 600, width: 120, height: 120 });
    for (const [j, other] of qrs.entries()) {
      if (j === i || !other) continue;
      page.node.setXObject(PDFName.of(`Unused${j}`), other.ref);
    }
  }
  return doc.save();
}

const ORDER = [
  {
    ticket: "990000001",
    scan: "1010100001",
    date: "8/24",
    sec: "1/Zz/aaa+bbb/ccc111",
  },
  {
    ticket: "990000002",
    scan: "2020200002",
    date: "8/24",
    sec: "1/Zz/ddd+eee/fff222",
  },
  {
    ticket: "990000003",
    scan: "3030300003",
    date: "8/26",
    sec: "1/Zz/ggg+hhh/iii333",
  },
];

console.log(`\nSAP passes e2e → ${BASE}\n`);

// ---------------------------------------------------------------- seed a camp
const admin = await account("admin");
const officer = await account("officer");
const holder = await account("holder");
const stranger = await account("stranger");

const campId = crypto.randomUUID();
await db
  .insert(camp)
  .values({ id: campId, name: `SAP Camp ${STAMP}`, slug: `sap-${STAMP}` });
const editionId = crypto.randomUUID();
await db
  .insert(campEdition)
  .values({ id: editionId, campId, year: YEAR, label: String(YEAR) });

const mids: Record<string, string> = {};
for (const [who, role] of [
  [admin, "admin"],
  [officer, "officer"],
  [holder, "member"],
  [stranger, "member2"],
] as const) {
  const id = crypto.randomUUID();
  mids[role] = id;
  await db.insert(membership).values({
    id,
    organizationId: campId,
    userId: who.id,
    role: role === "member2" ? "member" : role,
    wizardStep: 1,
  });
}
for (const key of ["passes", "roster"] as const) {
  await setFeatureState({
    campId,
    key,
    state: "on",
    updatedByMembershipId: mids.admin as string,
  });
}

// 1. Import a real multipart upload.
const order = await buildOrder(YEAR, ORDER);
const imported = await upload(officer.cookie, order, "order.pdf");
const stockRows = await db
  .select()
  .from(setupPassStock)
  .where(eq(setupPassStock.editionId, editionId));
check(
  "1. importing the vendor PDF creates one pass per page",
  imported.status === 200 && stockRows.length === ORDER.length,
  `HTTP ${imported.status}, ${stockRows.length} rows`,
);
check(
  "1b. the QR-only scan codes were read",
  ORDER.every((o) => stockRows.some((s) => s.scanCode === o.scan)),
);
check(
  "1c. dates came off the page, with the year from the event line",
  stockRows.filter((s) => s.onOrAfterDate === `${YEAR}-08-24`).length === 2,
);

/** Live (non-void) passes held for a date — the only capacity there is now
 * that quotas are gone. */
const heldFor = async (date: string) => {
  const rows = await db
    .select()
    .from(setupPassStock)
    .where(
      and(
        eq(setupPassStock.editionId, editionId),
        eq(setupPassStock.onOrAfterDate, date),
      ),
    );
  return rows.filter((r) => r.status !== "void").length;
};
check(
  "1d. capacity for a date is simply the passes imported for it",
  (await heldFor(`${YEAR}-08-24`)) === 2,
  `held ${await heldFor(`${YEAR}-08-24`)}`,
);

// 2. Re-uploading the same order must not double the camp's allocation.
await upload(officer.cookie, order, "order.pdf");
const afterRe = await db
  .select()
  .from(setupPassStock)
  .where(eq(setupPassStock.editionId, editionId));
check(
  "2. re-importing the same order adds nothing",
  afterRe.length === ORDER.length,
  `${afterRe.length} rows`,
);

// 3. A PDF for another year is refused outright, not imported mis-dated.
const wrongYear = await buildOrder(2024, [
  { ticket: "980000001", scan: "4040400004", date: "8/21", sec: "1/Zz/x+y/z" },
]);
const wrongRes = await upload(officer.cookie, wrongYear, "2024.pdf");
const afterWrong = await db
  .select()
  .from(setupPassStock)
  .where(eq(setupPassStock.editionId, editionId));
check(
  "3. a PDF from another year is refused",
  wrongRes.status === 400 && afterWrong.length === ORDER.length,
  `HTTP ${wrongRes.status}, ${afterWrong.length} rows`,
);

// 4. A member cannot import.
const memberImport = await upload(holder.cookie, order, "order.pdf");
check(
  "4. a member can't import passes",
  memberImport.status === 403,
  `HTTP ${memberImport.status}`,
);

// ------------------------------------------------------------------- assign
const target = stockRows.find((s) => s.scanCode === ORDER[0]?.scan);
if (!target) throw new Error("no stock row to work with");

const assignRes = await post("/passes", officer.cookie, {
  intent: "assignStock",
  id: target.id,
  granteeRef: `m:${mids.member}`,
});
check("5. an officer sets a pass aside", assignRes.status === 200);

// 6. THE assertion: assigned reveals nothing, to anyone.
const holderPage = await get("/passes", holder.cookie);
const holderHtml = await holderPage.text();
check(
  "6. the holder's page does NOT contain the codes while merely assigned",
  !holderHtml.includes(target.scanCode) &&
    !holderHtml.includes(target.securityCode),
);
check(
  "6b. it does tell them a pass is set aside",
  holderHtml.includes("set aside"),
);
const officerHtml = await (await get("/passes", officer.cookie)).text();
check(
  "6c. not even the officer's page carries the codes",
  !officerHtml.includes(target.scanCode) &&
    !officerHtml.includes(target.securityCode),
);
const earlyDownload = await get(`/sap/pass/${target.id}`, holder.cookie);
check(
  "6d. the PDF download is refused before release",
  earlyDownload.status === 404,
  `HTTP ${earlyDownload.status}`,
);

// ------------------------------------------------------------------ release
const releaseRes = await post("/passes", officer.cookie, {
  intent: "releaseStock",
  id: target.id,
});
check("7. an officer releases it", releaseRes.status === 200);

const afterRelease = await (await get("/passes", holder.cookie)).text();
check(
  "7b. now the holder sees both codes",
  afterRelease.includes(target.scanCode) &&
    afterRelease.includes(target.securityCode),
);
const strangerHtml = await (await get("/passes", stranger.cookie)).text();
check(
  "7c. another member still sees neither",
  !strangerHtml.includes(target.scanCode) &&
    !strangerHtml.includes(target.securityCode),
);

// 8. The download, and the defect it exists to prevent.
const pdfRes = await get(`/sap/pass/${target.id}`, holder.cookie);
const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
const drawn = await scanCodesInPdf(pdfBytes);
const contained = await scanCodesInEmbeddedImages(pdfBytes);
check("8. the holder can download the pass", pdfRes.status === 200);
check(
  "8b. it shows exactly their pass",
  drawn.length === 1 && drawn[0] === target.scanCode,
  drawn.join(","),
);
check(
  "8c. and CONTAINS no other pass — the leak the hand-cut files had",
  contained.length === 1 && contained[0] === target.scanCode,
  `contains ${contained.length}`,
);
const strangerPdf = await get(`/sap/pass/${target.id}`, stranger.cookie);
check(
  "8d. another member downloading it gets 404",
  strangerPdf.status === 404,
  `HTTP ${strangerPdf.status}`,
);

// 9. Release is one-way.
const takeBack = await post("/passes", officer.cookie, {
  intent: "unassignStock",
  id: target.id,
});
check(
  "9. a released pass can't be quietly taken back",
  takeBack.status === 409,
  `HTTP ${takeBack.status}`,
);

// 10. Voiding: admin only, reason required, and it doesn't restock.
const officerVoid = await post("/passes", officer.cookie, {
  intent: "voidStock",
  id: target.id,
  reason: "sent to the wrong person",
});
check(
  "10. an officer can't void",
  officerVoid.status === 403,
  `HTTP ${officerVoid.status}`,
);
const noReason = await post("/passes", admin.cookie, {
  intent: "voidStock",
  id: target.id,
  reason: "",
});
check(
  "10b. an admin must say why",
  noReason.status === 409,
  `HTTP ${noReason.status}`,
);
const voided = await post("/passes", admin.cookie, {
  intent: "voidStock",
  id: target.id,
  reason: "sent to the wrong person",
});
const [voidRow] = await db
  .select()
  .from(setupPassStock)
  .where(eq(setupPassStock.id, target.id));
check(
  "10c. an admin with a reason voids it",
  voided.status === 200 && voidRow?.status === "void",
  `HTTP ${voided.status}, status ${voidRow?.status}`,
);
check(
  "10d. voiding does NOT put it back in the pool",
  voidRow?.status !== "available",
);
// The camp is genuinely one pass short for that date now. With one ledger
// there is nothing to keep in step — the count simply drops.
check(
  "10e. and the camp is one pass shorter for that date",
  (await heldFor(`${YEAR}-08-24`)) === 1,
  `held ${await heldFor(`${YEAR}-08-24`)}`,
);

// ------------------------------------------------------------- group sheet
const rest = afterRe.filter((s) => s.id !== target.id);
for (const s of rest) {
  await post("/passes", officer.cookie, {
    intent: "assignStock",
    id: s.id,
    granteeRef: `m:${mids.member}`,
  });
  await post("/passes", officer.cookie, {
    intent: "releaseStock",
    id: s.id,
  });
}
const ids = rest.map((s) => s.id).join(",");
const sheetRes = await get(`/sap/group?ids=${ids}`, holder.cookie);
const sheet = new Uint8Array(await sheetRes.arrayBuffer());
const sheetCodes = await scanCodesInPdf(sheet);
check("11. the holder can download a group sheet", sheetRes.status === 200);
check(
  "11b. every pass on it round-trips as a scannable QR",
  sheetCodes.length === rest.length &&
    rest.every((s) => sheetCodes.includes(s.scanCode)),
  sheetCodes.join(","),
);
const strangerSheet = await get(`/sap/group?ids=${ids}`, stranger.cookie);
check(
  "11c. someone else's ids are refused, not silently dropped",
  strangerSheet.status === 404,
  `HTTP ${strangerSheet.status}`,
);

// 12. The officer screens actually render (an SSR throw still returns 200, so
//     asserting on content is the only honest check).
const officerPage = await (await get("/passes", officer.cookie)).text();
check(
  "12. the officer sees the stock table",
  officerPage.includes("Pass stock"),
);
check(
  "12b. and the import card",
  officerPage.includes("Import passes from the vendor PDF"),
);
const memberPage = await (await get("/passes", stranger.cookie)).text();
check(
  "12c. a member sees neither",
  !memberPage.includes("Pass stock") &&
    !memberPage.includes("Import passes from the vendor PDF"),
);

// 13. The gap list: someone arriving before gates open with no pass set aside.
//     They never requested one, so the pending-request queue can't show them —
//     this card is the only place they surface.
const strangerAttendeeId = await ensureMemberAttendee(
  campId,
  editionId,
  mids.member2 as string,
);
await db
  .update(attendee)
  .set({ arrivalDate: `${YEAR}-08-25`, status: "coming" })
  .where(eq(attendee.id, strangerAttendeeId));
const withGap = await (await get("/passes", officer.cookie)).text();
check(
  "13. an early arrival with no pass shows in the needs list",
  withGap.includes("Needs a pass"),
);

// 14. One ledger: assigning a pass IS the grant. A request must not be left
//     sitting "requested" beside a pass the person already holds, and taking
//     the pass back must reopen the ask rather than leave them looking served.
const asker = await post("/passes", stranger.cookie, { intent: "requestPass" });
check("14. a member can ask for a pass", asker.status === 200);

// The three passes above are all spoken for by now, so bring in one more —
// which also re-checks that a second order tops up the same edition.
await upload(
  officer.cookie,
  await buildOrder(YEAR, [
    {
      ticket: "990000004",
      scan: "4040400004",
      date: "8/24",
      sec: "1/Zz/jjj+kkk/lll444",
    },
  ]),
  "top-up.pdf",
);
const spare = (
  await db
    .select()
    .from(setupPassStock)
    .where(eq(setupPassStock.editionId, editionId))
).find((s) => s.status === "available");
if (!spare) throw new Error("no spare pass left to assign");

await post("/passes", officer.cookie, {
  intent: "assignStock",
  id: spare.id,
  granteeRef: `m:${mids.member2}`,
});
const [afterAssign] = await db
  .select()
  .from(setupPass)
  .where(eq(setupPass.editionId, editionId));
const [stockAfterAssign] = await db
  .select()
  .from(setupPassStock)
  .where(eq(setupPassStock.id, spare.id));
check(
  "14b. assigning a pass satisfies their request",
  afterAssign?.status === "granted",
  `request is ${afterAssign?.status}`,
);
check(
  "14c. and the pass records which request it satisfied",
  stockAfterAssign?.setupPassId === afterAssign?.id,
);

await post("/passes", officer.cookie, {
  intent: "unassignStock",
  id: spare.id,
});
const [afterTakeBack] = await db
  .select()
  .from(setupPass)
  .where(eq(setupPass.editionId, editionId));
check(
  "14d. taking it back reopens their request",
  afterTakeBack?.status === "requested",
  `request is ${afterTakeBack?.status}`,
);

// 15. Quotas are gone: there is no second number to drift.
const quotaless = await (await get("/passes", officer.cookie)).text();
check(
  "15. the officer screen no longer shows a quota ledger",
  !quotaless.includes("Pass dates &amp; quotas") &&
    !quotaless.includes("Pass dates & quotas"),
);
check(
  "15b. it shows the coverage summary instead",
  quotaless.includes("Setup access at a glance"),
);

// 16. The to-do must clear when you simply HOLD a pass. An officer setting one
//     aside for somebody who never filed a request used to leave them staring
//     at "Request a Setup Access Pass" with the request form correctly hidden —
//     a to-do with no way to clear it.
const holderMid = mids.member as string;
const holderAttendee = await ensureMemberAttendee(campId, editionId, holderMid);
await db
  .update(attendee)
  .set({ arrivalDate: `${YEAR}-08-25`, status: "coming" })
  .where(eq(attendee.id, holderAttendee));
// Make sure they hold one and have NO request of their own.
await db.delete(setupPass).where(eq(setupPass.attendeeId, holderAttendee));
const spare2 = (
  await db
    .select()
    .from(setupPassStock)
    .where(eq(setupPassStock.editionId, editionId))
).find((s) => s.status === "available");
if (spare2) {
  await post("/passes", officer.cookie, {
    intent: "assignStock",
    id: spare2.id,
    granteeRef: `m:${holderMid}`,
  });
}

const snapshot = (await loadAskSnapshots(campId, editionId, YEAR)).get(
  holderMid,
);
check(
  "16. holding a pass settles the setup-pass to-do",
  snapshot?.setupPassSettled === true,
  `settled=${snapshot?.setupPassSettled}, held=${spare2?.id ?? "none"}`,
);
if (snapshot) {
  const todo = outstandingAsks(snapshot, {
    weeksUntilEvent: 1,
    featureStates: { passes: "on" },
    role: "member",
  }).map((a) => a.key);
  check(
    "16b. so it is off their list",
    !todo.includes("setup_pass"),
    todo.join(","),
  );
}

// 17. Guests must be assignable AND identifiable. A camp with a dozen guests
//     cannot use a picker of bare first names — and reading the page must not
//     disturb work already done, which is the thing that would actually hurt.
const hostMid = mids.member as string;
const adultGuest = crypto.randomUUID();
const childGuest = crypto.randomUUID();
await db.insert(attendee).values([
  {
    id: adultGuest,
    campId,
    editionId,
    hostMembershipId: hostMid,
    name: "Samwise Guestee",
    status: "coming",
    arrivalDate: `${YEAR}-08-26`,
  },
  {
    id: childGuest,
    campId,
    editionId,
    hostMembershipId: hostMid,
    name: "Tiny Guestee",
    status: "coming",
    arrivalDate: `${YEAR}-08-26`,
    ageBand: "under_13",
  },
]);

// Everything imported so far is spoken for, so bring in one more to assign.
await upload(
  officer.cookie,
  await buildOrder(YEAR, [
    {
      ticket: "990000005",
      scan: "5050500005",
      date: "8/24",
      sec: "1/Zz/mmm+nnn/ooo555",
    },
  ]),
  "guest-topup.pdf",
);

// Snapshot every pass BEFORE, so we can prove nothing already assigned or
// released moved.
const before = await db
  .select()
  .from(setupPassStock)
  .where(eq(setupPassStock.editionId, editionId));

const officerView = await (await get("/passes", officer.cookie)).text();
check(
  "17. an over-13 guest is offered for assignment",
  officerView.includes("Samwise Guestee"),
);
check(
  "17b. named by whoever brought them, not just a bare first name",
  officerView.includes("guest of"),
);
check(
  "17c. an under-13 guest is not offered — they need no pass",
  !officerView.includes("Tiny Guestee"),
);

const spare3 = before.find((s) => s.status === "available");
if (spare3) {
  const res = await post("/passes", officer.cookie, {
    intent: "assignStock",
    id: spare3.id,
    granteeRef: `a:${adultGuest}`,
  });
  check("17d. a pass can be set aside for a guest", res.status === 200);
  const [now] = await db
    .select()
    .from(setupPassStock)
    .where(eq(setupPassStock.id, spare3.id));
  check(
    "17e. and it lands on that guest",
    now?.assignedAttendeeId === adultGuest && now?.status === "assigned",
    `attendee=${now?.assignedAttendeeId}, status=${now?.status}`,
  );
}

const after = await db
  .select()
  .from(setupPassStock)
  .where(eq(setupPassStock.editionId, editionId));
const untouched = before.every((b) => {
  if (b.id === spare3?.id) return true; // the one we deliberately changed
  const a = after.find((x) => x.id === b.id);
  return (
    a?.status === b.status &&
    a?.assignedAttendeeId === b.assignedAttendeeId &&
    a?.releasedAt?.getTime() === b.releasedAt?.getTime() &&
    a?.scanCode === b.scanCode
  );
});
check(
  "17f. every pass assigned or released earlier is untouched",
  untouched,
  `${before.length} pre-existing rows`,
);

// 18. Somebody who said "not this year" must not be offered a pass, and a pass
//     they already hold must be visibly reclaimable rather than silently lost.
const quitterMid = mids.member2 as string;
const quitterAttendee = await ensureMemberAttendee(
  campId,
  editionId,
  quitterMid,
);
await db
  .update(attendee)
  .set({ status: "not_coming" })
  .where(eq(attendee.id, quitterAttendee));

const afterQuit = await (await get("/passes", officer.cookie)).text();
check(
  "18. a member who isn't coming is no longer offered a pass",
  !afterQuit.includes("SAP stranger ·"),
  "picker still lists them",
);

// The guest holding a pass drops out too.
await db
  .update(attendee)
  .set({ status: "not_coming" })
  .where(eq(attendee.id, adultGuest));
const afterGuestQuit = await (await get("/passes", officer.cookie)).text();
check(
  "18b. and neither is a guest who dropped out",
  !afterGuestQuit.includes("Samwise Guestee ·"),
);
check(
  "18c. but the pass they already hold is flagged, not forgotten",
  afterGuestQuit.includes("reclaim?"),
);

// 19. The camper-facing "your group" card: every person in the party, their
//     dates, and whether a pass is sorted — with the buttons beside the answer.
const groupCardPage = await (await get("/passes", holder.cookie)).text();
check("19. the group card renders", groupCardPage.includes("Your group"));
check(
  "19b. it names the guests in their party, not only themselves",
  groupCardPage.includes("Samwise Guestee"),
);
check(
  "19c. and says plainly where each one stands on a pass",
  groupCardPage.includes("no pass requested yet") ||
    groupCardPage.includes("set aside") ||
    groupCardPage.includes("Pass ready"),
);

// A host can set a guest's dates from here, on the event calendar.
const stay = await post("/passes", holder.cookie, {
  intent: "setStay",
  attendeeId: adultGuest,
  arrivalDate: `${YEAR}-08-25`,
  departureDate: `${YEAR}-08-31`,
});
const [guestAfter] = await db
  .select()
  .from(attendee)
  .where(eq(attendee.id, adultGuest));
check("19d. a host can set a guest's stay", stay.status === 200);
check(
  "19e. and it saves both ends",
  guestAfter?.arrivalDate === `${YEAR}-08-25` &&
    guestAfter?.departureDate === `${YEAR}-08-31`,
  `${guestAfter?.arrivalDate} → ${guestAfter?.departureDate}`,
);

const backwards = await post("/passes", holder.cookie, {
  intent: "setStay",
  attendeeId: adultGuest,
  arrivalDate: `${YEAR}-08-28`,
  departureDate: `${YEAR}-08-25`,
});
check(
  "19f. a stay that ends before it starts is refused",
  backwards.status === 400,
  `HTTP ${backwards.status}`,
);

// And nobody can reach outside their own party.
const notMine = await post("/passes", stranger.cookie, {
  intent: "setStay",
  attendeeId: adultGuest,
  arrivalDate: `${YEAR}-08-24`,
  departureDate: `${YEAR}-08-30`,
});
check(
  "19g. someone else's guest is out of reach",
  notMine.status === 403,
  `HTTP ${notMine.status}`,
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
