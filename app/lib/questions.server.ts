/**
 * Server-side data access for the camp questionnaire. Question definitions are
 * camp-scoped config; answers are edition-scoped (per-year). Pairs with the pure
 * helpers in questions.ts.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.server";
import { campQuestion, questionAnswer } from "../../db/schema";
import { audienceForRole } from "./wizard";

export type QuestionRow = typeof campQuestion.$inferSelect;

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

/** A member's answers for one edition: questionId -> stored value. */
export async function loadAnswers(opts: {
  editionId: string;
  membershipId: string;
}): Promise<Record<string, string>> {
  const rows = await db
    .select({
      questionId: questionAnswer.questionId,
      value: questionAnswer.value,
    })
    .from(questionAnswer)
    .where(
      and(
        eq(questionAnswer.editionId, opts.editionId),
        eq(questionAnswer.membershipId, opts.membershipId),
      ),
    );
  const out: Record<string, string> = {};
  for (const r of rows) if (r.value != null) out[r.questionId] = r.value;
  return out;
}

/** Upsert one answer (edition-scoped). Pass value=null to clear it. */
export async function setAnswer(opts: {
  campId: string;
  editionId: string;
  membershipId: string;
  questionId: string;
  value: string | null;
}): Promise<void> {
  await db
    .insert(questionAnswer)
    .values({
      id: crypto.randomUUID(),
      campId: opts.campId,
      editionId: opts.editionId,
      membershipId: opts.membershipId,
      questionId: opts.questionId,
      value: opts.value,
    })
    .onConflictDoUpdate({
      target: [
        questionAnswer.editionId,
        questionAnswer.membershipId,
        questionAnswer.questionId,
      ],
      set: { value: opts.value, updatedAt: new Date() },
    });
}
