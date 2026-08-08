/**
 * Does the invite-only lockdown still hold for PASSKEY-first signup?
 *
 * This is the highest-risk regression in the passkey work. The instance-level
 * "invite-only" gate used to live in exactly one place — the better-auth
 * user-create hook — and its comment reasoned that passkeys were exempt
 * *because passkeys never create a user*. Passkey-first signup makes that
 * false. If the gate doesn't hold on this path, an invite-only deployment
 * silently becomes an open one.
 *
 * No browser needed: the gate fires at /passkey/generate-register-options,
 * which is a plain GET, well before any WebAuthn ceremony.
 *
 * Run against a SCRATCH server with an isolated DB:
 *   DATABASE_PATH=./data/verify/passkey-gate.db PUBLIC_BASE_URL=http://localhost:17924 \
 *     PORT=17924 bun run dev
 *   bun e2e/passkey-invite-gate.ts
 */
import { Database } from "bun:sqlite";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17924";
const DB = process.env.E2E_DB_PATH ?? "./data/verify/passkey-gate.db";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function setOpenSignups(allow: boolean) {
  const db = new Database(DB);
  db.exec("PRAGMA journal_mode = WAL;");
  db.run(
    `INSERT INTO instance_setting (id, allow_camp_creation, allow_open_signups, updated_at)
     VALUES ('singleton', 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET allow_open_signups = excluded.allow_open_signups`,
    [allow ? 1 : 0, Date.now()],
  );
  db.close();
}

/** Ask for a signup handle, then try to start a registration ceremony with it.
 * Returns the status of the ceremony-options request (the gated one). */
async function attemptSignup(email: string) {
  const start = await fetch(`${BASE}/api/passkey-signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Gate Tester", email }),
  });
  const startBody = await start.json().catch(() => ({}));
  if (!start.ok) return { startStatus: start.status, optionsStatus: null };

  const opts = await fetch(
    `${BASE}/api/auth/passkey/generate-register-options?context=${encodeURIComponent(startBody.context)}`,
    { headers: { Origin: BASE } },
  );
  return { startStatus: start.status, optionsStatus: opts.status };
}

async function main() {
  console.log("--- open signups ON (baseline) ---");
  setOpenSignups(true);
  const open = await attemptSignup(`gate-open-${Date.now()}@example.com`);
  check(
    "with open signups, passkey registration options are issued",
    open.optionsStatus === 200,
    `options=${open.optionsStatus}`,
  );

  console.log("--- invite-only ON ---");
  setOpenSignups(false);
  const locked = await attemptSignup(`gate-locked-${Date.now()}@example.com`);
  check(
    "invite-only REFUSES passkey signup without an unlock cookie",
    locked.optionsStatus === 403,
    `options=${locked.optionsStatus} (403 expected; anything else means the lockdown is bypassable via the passkey path)`,
  );

  // Leave the scratch DB permissive so a rerun starts from a clean baseline.
  setOpenSignups(true);

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
