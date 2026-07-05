/**
 * Server-side state for the season-aware wizard: what's scheduled for a camper,
 * what they've already resolved, and the upserts the wizard's actions call. Pairs
 * with the pure catalog/scheduler in wizard.ts.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.server";
import { participation, wizardAsk } from "../../db/schema";
import { weeksUntilEvent } from "./brc";
import { type AskDef, type AskKey, scheduleAsks } from "./wizard";

export type ParticipationStatus = "unknown" | "coming" | "maybe" | "not_coming";

export type WizardState = {
  scheduled: AskDef[];
  /** ask_key -> "done" | "skipped" for asks this camper has resolved. */
  resolved: Record<string, string>;
  /** ask_keys still awaiting action (scheduled but not resolved). */
  pending: AskKey[];
  participation: {
    status: ParticipationStatus;
    arrivalDate: string | null;
    departureDate: string | null;
    note: string | null;
  };
};

export async function loadWizardState(opts: {
  editionId: string;
  membershipId: string;
  role: string;
  year: number;
}): Promise<WizardState> {
  const { editionId, membershipId, role, year } = opts;

  const askRows = await db
    .select({ askKey: wizardAsk.askKey, status: wizardAsk.status })
    .from(wizardAsk)
    .where(
      and(
        eq(wizardAsk.editionId, editionId),
        eq(wizardAsk.membershipId, membershipId),
      ),
    );
  const resolved: Record<string, string> = {};
  for (const r of askRows) resolved[r.askKey] = r.status;

  const [part] = await db
    .select({
      status: participation.status,
      arrivalDate: participation.arrivalDate,
      departureDate: participation.departureDate,
      note: participation.note,
    })
    .from(participation)
    .where(
      and(
        eq(participation.editionId, editionId),
        eq(participation.membershipId, membershipId),
      ),
    )
    .limit(1);

  const scheduled = scheduleAsks({
    role,
    weeksUntilEvent: weeksUntilEvent(year),
  });
  const pending = scheduled.filter((a) => !resolved[a.key]).map((a) => a.key);

  return {
    scheduled,
    resolved,
    pending,
    participation: {
      status: (part?.status as ParticipationStatus) ?? "unknown",
      arrivalDate: part?.arrivalDate ?? null,
      departureDate: part?.departureDate ?? null,
      note: part?.note ?? null,
    },
  };
}

/** Mark an ask done (acted on) or skipped (passed). Idempotent per edition. */
export async function resolveAsk(opts: {
  campId: string;
  editionId: string;
  membershipId: string;
  askKey: AskKey;
  status: "done" | "skipped";
}): Promise<void> {
  await db
    .insert(wizardAsk)
    .values({
      id: crypto.randomUUID(),
      campId: opts.campId,
      editionId: opts.editionId,
      membershipId: opts.membershipId,
      askKey: opts.askKey,
      status: opts.status,
    })
    .onConflictDoUpdate({
      target: [wizardAsk.editionId, wizardAsk.membershipId, wizardAsk.askKey],
      set: { status: opts.status, updatedAt: new Date() },
    });
}

/** Upsert a camper's per-year RSVP. The "coming back?" question now lives inside
 * the `questionnaire` step, so its ask resolution is handled there — not here. */
export async function setParticipation(opts: {
  campId: string;
  editionId: string;
  membershipId: string;
  status: ParticipationStatus;
  arrivalDate?: string | null;
  departureDate?: string | null;
  note?: string | null;
}): Promise<void> {
  await db
    .insert(participation)
    .values({
      id: crypto.randomUUID(),
      campId: opts.campId,
      editionId: opts.editionId,
      membershipId: opts.membershipId,
      status: opts.status,
      arrivalDate: opts.arrivalDate ?? null,
      departureDate: opts.departureDate ?? null,
      note: opts.note ?? null,
    })
    .onConflictDoUpdate({
      target: [participation.editionId, participation.membershipId],
      set: {
        status: opts.status,
        ...(opts.arrivalDate !== undefined
          ? { arrivalDate: opts.arrivalDate }
          : {}),
        ...(opts.departureDate !== undefined
          ? { departureDate: opts.departureDate }
          : {}),
        ...(opts.note !== undefined ? { note: opts.note } : {}),
        updatedAt: new Date(),
      },
    });
}
