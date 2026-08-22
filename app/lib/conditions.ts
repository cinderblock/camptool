/**
 * Conditional questions — "only ask this if that".
 *
 * The question bank could always ask everyone everything, which meant a camp
 * either asked follow-ups of people they couldn't apply to ("which camp did you
 * camp with?" of someone who's never been) or hardcoded a checkbox-reveal into
 * one form. This is the general version, deferred from the 2026-07-07
 * assessment and now due (`plans/questions-unification.md`).
 *
 * Pure — no database, no server imports — so both the wizard and the public
 * apply form can decide with the same code, and so the rules below can be
 * tested without a fixture.
 *
 * Three rules do the real work, and each of them prevents a specific failure:
 *
 *   1. **A hidden question is never required.** Required-enforcement blocks
 *      Next until in-scope required questions are answered. A hidden required
 *      question is an unpassable gate with no visible cause — the camper sees a
 *      disabled button and nothing to fix.
 *
 *   2. **A hidden question's answer is kept, not cleared.** Answer "yes", fill
 *      in the follow-up, change your mind to "no" — flipping back must not have
 *      destroyed what you typed. The cost is that officer reports have to
 *      filter on the controlling answer too, rather than reading presence as
 *      truth; `visibleAnswers` exists for exactly that.
 *
 *   3. **One level, no cycles.** A question may not depend on one that itself
 *      depends on something, and may not depend on itself. Kept deliberately
 *      shallow: chained conditions are far harder to reason about at the point
 *      an officer is authoring them, and nothing has asked for it.
 */

/** The subset of a question this module needs. */
export type Conditional = {
  id: string;
  showIfQuestionId: string | null;
  showIfValue: string | null;
};

/** Answers as the app stores them: question id → text value (see
 * `db/schema/question.ts` — every type serialises to text). */
export type AnswerMap = Record<string, string | null | undefined>;

/**
 * Does this question's condition currently hold?
 *
 * Unconditional questions always show. A condition pointing at a question that
 * no longer exists also shows — an orphaned condition should fail open, because
 * silently hiding a question forever is worse than asking one that's become
 * redundant.
 */
export function isShown(
  q: Conditional,
  answers: AnswerMap,
  known?: ReadonlySet<string>,
): boolean {
  const target = q.showIfQuestionId;
  if (!target || q.showIfValue === null) return true;
  if (known && !known.has(target)) return true; // orphaned → fail open

  const given = answers[target];
  if (given === null || given === undefined || given === "") return false;
  return matches(given, q.showIfValue);
}

/**
 * Compare a stored answer against a condition value.
 *
 * `multi_select` stores a JSON array, so the condition matches when the value
 * is *among* the selections rather than equal to the whole list — "shows when
 * they picked Tuesday" should hold whether or not they also picked Wednesday.
 * Everything else is string equality against the stored text.
 */
function matches(given: string, want: string): boolean {
  if (given === want) return true;
  if (given.startsWith("[")) {
    try {
      const parsed = JSON.parse(given);
      if (Array.isArray(parsed)) return parsed.some((v) => String(v) === want);
    } catch {
      // Not the JSON we assumed; fall through to "no match".
    }
  }
  return false;
}

/** Every question currently worth showing, in the order given. */
export function shownQuestions<T extends Conditional>(
  questions: T[],
  answers: AnswerMap,
): T[] {
  const known = new Set(questions.map((q) => q.id));
  return questions.filter((q) => isShown(q, answers, known));
}

/**
 * Answers with the hidden ones dropped — what a report should read.
 *
 * Rule 2 keeps a hidden question's answer in the database, so "they have an
 * answer" stops meaning "this applies to them". Anything summarising answers
 * has to come through here or it will count people who said something and then
 * took back the premise.
 */
export function visibleAnswers<T extends Conditional>(
  questions: T[],
  answers: AnswerMap,
): AnswerMap {
  const shown = new Set(shownQuestions(questions, answers).map((q) => q.id));
  const out: AnswerMap = {};
  for (const [id, value] of Object.entries(answers)) {
    if (shown.has(id)) out[id] = value;
  }
  return out;
}

/** Why a proposed condition can't be saved, or null if it's fine. */
export type ConditionProblem =
  | "self"
  | "missing"
  | "chain"
  | "needs-value"
  | null;

/**
 * Validate a condition an officer is about to save.
 *
 * Server-side, always: the authoring UI can only offer sensible targets, but a
 * cycle reaching the database would make the questionnaire un-renderable for
 * every camper at once.
 */
export function checkCondition(opts: {
  /** The question being edited. */
  questionId: string;
  showIfQuestionId: string | null;
  showIfValue: string | null;
  /** Every question in the camp, for the existence and chain checks. */
  all: Conditional[];
}): ConditionProblem {
  const { questionId, showIfQuestionId, showIfValue, all } = opts;
  if (!showIfQuestionId) return null; // clearing a condition is always fine
  if (showIfQuestionId === questionId) return "self";
  if (showIfValue === null || showIfValue === "") return "needs-value";

  const target = all.find((q) => q.id === showIfQuestionId);
  if (!target) return "missing";
  // One level: the controlling question must not itself be conditional.
  if (target.showIfQuestionId) return "chain";

  // Nothing may depend on THIS question either, or saving would create a
  // two-link chain from the other side.
  if (all.some((q) => q.showIfQuestionId === questionId)) return "chain";
  return null;
}

/** Human wording for a rejected condition. */
export function conditionMessage(
  problem: NonNullable<ConditionProblem>,
): string {
  switch (problem) {
    case "self":
      return "A question can't depend on itself.";
    case "missing":
      return "That question no longer exists.";
    case "needs-value":
      return "Pick the answer that should reveal this question.";
    case "chain":
      return "Conditions are one level deep — the question it depends on can't itself be conditional, and nothing can depend on this one.";
  }
}
