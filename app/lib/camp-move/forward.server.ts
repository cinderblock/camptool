/**
 * The old install, after a camp has moved away (plans/camp-portability.md,
 * "Forwarding old links"): requests for the camp go to its new home, path for
 * path, signed in when the browser is signed in here as one of its people.
 * Signed-out visitors get the "we've moved" page, which can sign them in here
 * once to carry the sign-in across.
 *
 * Runs in the root middleware on every request, so the list of live moves is
 * cached briefly per process.
 *
 * Server-only.
 */
import { sql } from "drizzle-orm";
import { redirect } from "react-router";
import { db } from "../../../db/client.server";
import { campSlugFromHost, pageUrl } from "../camp-host";
import { APEX, CAMP_SUBDOMAINS } from "../env.server";
import { getRealSession } from "../session.server";
import { handoffUrl } from "./handoff.server";
import {
  endExpiredMoves,
  liveMovesOut,
  type MoveOut,
  peopleOf,
} from "./move-out.server";

const CACHE_MS = 30_000;
let cache: { at: number; moves: MoveOut[]; camps: number } | null = null;

/** Drop the cache (after a move finishes or a camp arrives here). */
export function forgetMoves() {
  cache = null;
}

async function state() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  await endExpiredMoves();
  const moves = await liveMovesOut();
  const [{ n } = { n: 0 }] = moves.length
    ? await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM camp`)
    : [{ n: 0 }];
  cache = { at: Date.now(), moves, camps: n };
  return cache;
}

/** Paths that keep working on the old install: sign-in, the move itself,
 * and the site-wide pages for starting or bringing in a camp. */
const OWN =
  /^\/(?:api\/|\.well-known\/|moved\/|move-handoff|move-claim|login|handoff|import-camp|new-camp|new-passkey|assets\/|@|__|node_modules\/|app\/|_version)/;

async function campExists(slug: string) {
  const [row] = await db.all<{ id: string }>(
    sql`SELECT id FROM camp WHERE slug = ${slug} LIMIT 1`,
  );
  return !!row;
}

/** The live move a request is for, if it's for a camp that left. `whole`:
 * matched only because the site has no camps left at all. */
async function moveFor(
  request: Request,
  url: URL,
): Promise<{ move: MoveOut; whole: boolean } | null> {
  const { moves, camps } = await state();
  if (!moves.length) return null;
  const bySlug = async (slug: string) => {
    const m = moves.find((x) => x.campSlug === slug);
    return m && !(await campExists(slug)) ? { move: m, whole: false } : null;
  };
  const host = CAMP_SUBDOMAINS
    ? campSlugFromHost(new URL(request.url).host, APEX)
    : null;
  if (host) return bySlug(host);
  const pub = url.pathname.match(/^\/c\/([^/]+)/);
  if (pub?.[1]) return bySlug(pub[1]);
  // A site with no camps left (a self-hosted camp's own server, after it
  // moved): the whole site forwards to the newest move.
  const newest = moves[0];
  if (camps === 0 && newest) return { move: newest, whole: true };
  return null;
}

/** Forward a request for a camp that moved away, or null to carry on. */
export async function movedCampResponse(
  request: Request,
): Promise<Response | null> {
  const url = pageUrl(request.url);
  if (OWN.test(url.pathname)) return null;
  const found = await moveFor(request, url);
  const move = found?.move;
  if (!found || !move?.targetCampUrl) return null;
  const session = await getRealSession(request);
  // On a site that forwards wholesale, someone signed in who wasn't in the
  // camp (the site's own admin) still gets to use it.
  if (found.whole && session && !peopleOf(move).includes(session.user.id)) {
    return null;
  }
  // Public camp pages go to the camp's home there, which shows its public
  // page to anyone who isn't a member.
  const publicPage = url.pathname.startsWith("/c/");
  const target = publicPage
    ? move.targetCampUrl
    : new URL(url.pathname + url.search, move.targetCampUrl).href;
  if (request.method !== "GET") return redirect(target, 308);
  if (publicPage) return redirect(target);
  if (session) {
    const signed = await handoffUrl(move, session.user.id, target);
    if (signed) return redirect(signed);
  }
  return redirect(
    `${APEX.origin}/moved/${move.id}?next=${encodeURIComponent(target)}`,
  );
}

/** Origins the old install's passkeys may be used on, for
 * `/.well-known/webauthn` (WebAuthn Related Origin Requests). */
export async function relatedOrigins(): Promise<string[]> {
  const { moves } = await state();
  const out: string[] = [];
  for (const m of moves) {
    if (m.targetOrigin && !out.includes(m.targetOrigin))
      out.push(m.targetOrigin);
  }
  return out;
}
