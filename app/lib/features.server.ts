/**
 * Camp-feature state resolution + route gating (see plans/camp-features.md).
 * The catalog lives in features.ts (pure); this resolves each camp's chosen
 * states from `camp_feature` rows (absence = registry default) and provides
 * the route-loader guard.
 */
import { and, eq } from "drizzle-orm";
import { redirect } from "react-router";
import { db } from "../../db/client.server";
import { campFeature, membership } from "../../db/schema";
import {
  defaultFeatureState,
  FEATURES,
  type FeatureKey,
  type FeatureState,
  featureDef,
  featureVisibleTo,
} from "./features";

/** Effective state of every cataloged feature for a camp (defaults applied). */
export async function loadFeatureStates(
  campId: string,
): Promise<Map<FeatureKey, FeatureState>> {
  const rows = await db
    .select({ featureKey: campFeature.featureKey, state: campFeature.state })
    .from(campFeature)
    .where(eq(campFeature.campId, campId));
  return statesFromRows(rows);
}

/**
 * Feature states for every camp a user belongs to, in one query; returns a
 * lookup by camp id. Asked for
 * alongside the user's camps (`resolveActiveCamp`), so the page's feature gate
 * doesn't wait for the active camp first: one fewer D1 round trip on every
 * page (plans/fast-navigation.md).
 */
export async function loadUserFeatureStates(
  userId: string,
): Promise<(campId: string) => Map<FeatureKey, FeatureState>> {
  const rows = await db
    .select({
      campId: membership.organizationId,
      featureKey: campFeature.featureKey,
      state: campFeature.state,
    })
    .from(membership)
    .innerJoin(campFeature, eq(campFeature.campId, membership.organizationId))
    .where(eq(membership.userId, userId));
  const byCamp = new Map<string, { featureKey: string; state: string }[]>();
  for (const r of rows) {
    const list = byCamp.get(r.campId) ?? [];
    list.push(r);
    byCamp.set(r.campId, list);
  }
  // A camp with no rows still gets every feature at its default.
  return (campId) => statesFromRows(byCamp.get(campId) ?? []);
}

// The active camp's states, already loaded for this request, keyed by the
// request's own `active` object (so nothing outlives the request).
const preloaded = new WeakMap<object, Map<FeatureKey, FeatureState>>();

/** Record `active`'s feature states for `requireFeature` / `featureStatesFor`. */
export function rememberFeatureStates(
  active: object,
  states: Map<FeatureKey, FeatureState>,
): void {
  preloaded.set(active, states);
}

/** The active camp's feature states: preloaded when available, else queried. */
export async function featureStatesFor(active: {
  camp: { id: string };
}): Promise<Map<FeatureKey, FeatureState>> {
  return preloaded.get(active) ?? loadFeatureStates(active.camp.id);
}

function statesFromRows(
  rows: { featureKey: string; state: string }[],
): Map<FeatureKey, FeatureState> {
  const byKey = new Map(rows.map((r) => [r.featureKey, r.state]));
  return new Map(
    FEATURES.map((def) => {
      const raw = byKey.get(def.key);
      const state: FeatureState =
        raw === "off" || raw === "preview" || raw === "on"
          ? raw
          : defaultFeatureState(def);
      return [def.key, state];
    }),
  );
}

export async function getFeatureState(
  campId: string,
  key: FeatureKey,
): Promise<FeatureState> {
  const def = featureDef(key);
  if (!def) return "off";
  const [row] = await db
    .select({ state: campFeature.state })
    .from(campFeature)
    .where(and(eq(campFeature.campId, campId), eq(campFeature.featureKey, key)))
    .limit(1);
  const raw = row?.state;
  return raw === "off" || raw === "preview" || raw === "on"
    ? raw
    : defaultFeatureState(def);
}

export async function setFeatureState(opts: {
  campId: string;
  key: FeatureKey;
  state: FeatureState;
  updatedByMembershipId: string;
}): Promise<void> {
  await db
    .insert(campFeature)
    .values({
      id: crypto.randomUUID(),
      campId: opts.campId,
      featureKey: opts.key,
      state: opts.state,
      updatedByMembershipId: opts.updatedByMembershipId,
    })
    .onConflictDoUpdate({
      target: [campFeature.campId, campFeature.featureKey],
      set: {
        state: opts.state,
        updatedByMembershipId: opts.updatedByMembershipId,
        updatedAt: new Date(),
      },
    });
}

/**
 * Route-loader guard, used beside requireActiveCamp/requireActiveEdition:
 * bounce anyone who can't see the feature back to the Overview (same pattern
 * as the camp-less bounce — no dead-end 404 for a logged-in user). Returns the
 * state so preview pages can render the "officers only" banner.
 */
export async function requireFeature(
  active: { camp: { id: string }; membership: { role: string } },
  key: FeatureKey,
): Promise<FeatureState> {
  const state =
    preloaded.get(active)?.get(key) ??
    (await getFeatureState(active.camp.id, key));
  if (!featureVisibleTo(state, active.membership.role)) throw redirect("/");
  return state;
}
