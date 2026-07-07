/**
 * Server-side data access for the camp questionnaire. Question definitions are
 * camp-scoped config; answers are edition-scoped (per-year) except for
 * `once`-scoped questions, whose lifetime answer is stored edition-less.
 * Pairs with the pure helpers in questions.ts.
 */
import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "../../db/client.server";
import {
  campQuestion,
  membership,
  questionAnswer,
  recruitApplication,
  user,
} from "../../db/schema";
import { surfacedOnApplication } from "./questions";
import { audienceForRole } from "./wizard";

export type QuestionRow = typeof campQuestion.$inferSelect;

/** The name of whoever invited this member (from the invite tree), for the
 * `invited_by` question type to pre-fill. Prefers playa name, then real name;
 * null when they weren't invited (public applicant / founder). */
export async function loadInviterName(
  membershipId: string,
): Promise<string | null> {
  const [me] = await db
    .select({ inviter: membership.invitedByMembershipId })
    .from(membership)
    .where(eq(membership.id, membershipId))
    .limit(1);
  if (!me?.inviter) return null;
  const [inv] = await db
    .select({ name: user.name, playa: membership.playaName })
    .from(membership)
    .leftJoin(user, eq(membership.userId, user.id))
    .where(eq(membership.id, me.inviter))
    .limit(1);
  return inv?.playa || inv?.name || null;
}

/** Distinct active-member display names (playa name preferred) for the
 * `invited_by` dropdown, so "who invited you" isn't an open-ended text box. */
export async function loadInviterOptions(campId: string): Promise<string[]> {
  const rows = await db
    .select({ name: user.name, playa: membership.playaName })
    .from(membership)
    .leftJoin(user, eq(membership.userId, user.id))
    .where(
      and(
        eq(membership.organizationId, campId),
        eq(membership.status, "active"),
      ),
    );
  const names = new Set<string>();
  for (const r of rows) {
    const n = r.playa || r.name;
    if (n) names.add(n);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Active (non-archived) questions for a camp, in display order. */
export async function loadCampQuestions(
  campId: string,
): Promise<QuestionRow[]> {
  return db
    .select()
    .from(campQuestion)
    .where(
      and(eq(campQuestion.campId, campId), isNull(campQuestion.archivedAt)),
    )
    .orderBy(asc(campQuestion.sortOrder), asc(campQuestion.createdAt));
}

/** Narrow a question list to those relevant to a member's audience. */
export function filterByAudience<T extends { audience: string }>(
  questions: T[],
  role: string,
): T[] {
  const aud = audienceForRole(role);
  return questions.filter((q) => q.audience === "all" || q.audience === aud);
}

/** A member's answers for one edition, merged with their lifetime answers to
 * `once`-scoped questions (edition_id NULL): questionId -> stored value. An
 * edition-specific row wins over a lifetime one for the same question. */
export async function loadAnswers(opts: {
  editionId: string;
  membershipId: string;
}): Promise<Record<string, string>> {
  const rows = await db
    .select({
      questionId: questionAnswer.questionId,
      editionId: questionAnswer.editionId,
      value: questionAnswer.value,
    })
    .from(questionAnswer)
    .where(
      and(
        eq(questionAnswer.membershipId, opts.membershipId),
        or(
          eq(questionAnswer.editionId, opts.editionId),
          isNull(questionAnswer.editionId),
        ),
      ),
    );
  const out: Record<string, string> = {};
  for (const r of rows)
    if (r.editionId == null && r.value != null) out[r.questionId] = r.value;
  for (const r of rows)
    if (r.editionId != null && r.value != null) out[r.questionId] = r.value;
  return out;
}

/** Upsert one answer. `once`-scoped questions store their answer edition-less
 * (the lifetime fact); everything else is edition-scoped. Pass value=null to
 * clear it. */
export async function setAnswer(opts: {
  campId: string;
  editionId: string;
  membershipId: string;
  questionId: string;
  scope?: string;
  value: string | null;
}): Promise<void> {
  const once = opts.scope === "once";
  await db
    .insert(questionAnswer)
    .values({
      id: crypto.randomUUID(),
      campId: opts.campId,
      editionId: once ? null : opts.editionId,
      membershipId: opts.membershipId,
      questionId: opts.questionId,
      value: opts.value,
    })
    .onConflictDoUpdate(
      once
        ? {
            // Partial unique index (question_answer_once_unique) — must
            // repeat its WHERE clause, like attendee_member in wizard.server.
            target: [questionAnswer.membershipId, questionAnswer.questionId],
            targetWhere: isNull(questionAnswer.editionId),
            set: { value: opts.value, updatedAt: new Date() },
          }
        : {
            target: [
              questionAnswer.editionId,
              questionAnswer.membershipId,
              questionAnswer.questionId,
            ],
            set: { value: opts.value, updatedAt: new Date() },
          },
    );
}

/** Questions shown on a camp's public application form: application-surfaced,
 * for the recruit audience (applicants are by definition not members). */
export async function loadApplicationQuestions(
  campId: string,
): Promise<QuestionRow[]> {
  return (await loadCampQuestions(campId)).filter(
    (q) =>
      surfacedOnApplication(q.surface) &&
      (q.audience === "all" || q.audience === "recruit"),
  );
}

/** One-time import of a person's application-form answers into the question
 * bank, once they have a membership (works for both acceptance paths: direct
 * membership and better-auth invitation → later signup). Existing answers are
 * never overwritten. Cheap no-op when nothing is waiting — called from the
 * wizard/questions loaders. */
export async function importApplicationAnswers(opts: {
  campId: string;
  editionId: string;
  membershipId: string;
  userId: string;
}): Promise<void> {
  const apps = await db
    .select({ id: recruitApplication.id, answers: recruitApplication.answers })
    .from(recruitApplication)
    .where(
      and(
        eq(recruitApplication.campId, opts.campId),
        eq(recruitApplication.userId, opts.userId),
        isNotNull(recruitApplication.answers),
        isNull(recruitApplication.answersImportedAt),
      ),
    );
  if (apps.length === 0) return;

  const questions = await loadCampQuestions(opts.campId);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const existing = await loadAnswers({
    editionId: opts.editionId,
    membershipId: opts.membershipId,
  });

  for (const app of apps) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(app.answers ?? "{}");
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object") {
      for (const [questionId, value] of Object.entries(parsed)) {
        const q = byId.get(questionId);
        if (!q || typeof value !== "string" || !value) continue;
        if (existing[questionId]) continue; // theirs, and newer — keep it
        await setAnswer({
          campId: opts.campId,
          editionId: opts.editionId,
          membershipId: opts.membershipId,
          questionId,
          scope: q.scope,
          value,
        });
        existing[questionId] = value;
      }
    }
    await db
      .update(recruitApplication)
      .set({ answersImportedAt: new Date() })
      .where(eq(recruitApplication.id, app.id));
  }
}
