/**
 * Conditional questions. The three rules in `conditions.ts` each stop a
 * specific failure, so each gets a test that fails the way the bug would.
 */
import { describe, expect, test } from "bun:test";
import {
  type Conditional,
  checkCondition,
  isShown,
  shownQuestions,
  visibleAnswers,
} from "./conditions";

const q = (
  id: string,
  showIfQuestionId: string | null = null,
  showIfValue: string | null = null,
): Conditional => ({ id, showIfQuestionId, showIfValue });

const BEEN = q("been");
const WHICH = q("which", "been", "true");

describe("isShown", () => {
  test("an unconditional question always shows", () => {
    expect(isShown(BEEN, {})).toBe(true);
    expect(isShown(BEEN, { been: "false" })).toBe(true);
  });

  test("a condition that holds shows the question", () => {
    expect(isShown(WHICH, { been: "true" })).toBe(true);
  });

  test("a condition that doesn't hold hides it", () => {
    expect(isShown(WHICH, { been: "false" })).toBe(false);
  });

  test("an unanswered controlling question hides it", () => {
    // Not yet answered is not "yes". Showing the follow-up before the premise
    // is answered is the thing conditions exist to stop.
    expect(isShown(WHICH, {})).toBe(false);
    expect(isShown(WHICH, { been: "" })).toBe(false);
    expect(isShown(WHICH, { been: null })).toBe(false);
  });

  test("an orphaned condition fails OPEN", () => {
    // The controlling question was deleted. Asking a question that's become
    // redundant is recoverable; hiding one forever with no visible cause is
    // not.
    expect(isShown(WHICH, {}, new Set(["which"]))).toBe(true);
  });

  test("a multi_select matches when the value is among the picks", () => {
    const rv = q("rv", "vehicles", "RV");
    expect(isShown(rv, { vehicles: '["Car","RV"]' })).toBe(true);
    expect(isShown(rv, { vehicles: '["Car","Van"]' })).toBe(false);
    expect(isShown(rv, { vehicles: '["RV"]' })).toBe(true);
  });

  test("a value that merely looks like JSON doesn't crash it", () => {
    const weird = q("w", "other", "x");
    expect(isShown(weird, { other: "[not json" })).toBe(false);
  });
});

describe("shownQuestions", () => {
  test("keeps order and drops only the hidden", () => {
    const all = [BEEN, WHICH, q("why")];
    expect(shownQuestions(all, { been: "true" }).map((x) => x.id)).toEqual([
      "been",
      "which",
      "why",
    ]);
    expect(shownQuestions(all, { been: "false" }).map((x) => x.id)).toEqual([
      "been",
      "why",
    ]);
  });
});

describe("visibleAnswers", () => {
  test("a hidden question's answer is kept in storage but not reported", () => {
    // Rule 2: answering "yes", filling the follow-up, then flipping to "no"
    // must not destroy what was typed — but a report must not count it either.
    const stored = { been: "false", which: "Camp Somewhere" };
    expect(stored.which).toBe("Camp Somewhere");
    expect(visibleAnswers([BEEN, WHICH], stored)).toEqual({ been: "false" });
  });

  test("and is reported again the moment the premise comes back", () => {
    const stored = { been: "true", which: "Camp Somewhere" };
    expect(visibleAnswers([BEEN, WHICH], stored)).toEqual(stored);
  });
});

describe("checkCondition", () => {
  const all = [BEEN, WHICH];

  test("clearing a condition is always allowed", () => {
    expect(
      checkCondition({
        questionId: "which",
        showIfQuestionId: null,
        showIfValue: null,
        all,
      }),
    ).toBeNull();
  });

  test("a question can't depend on itself", () => {
    expect(
      checkCondition({
        questionId: "been",
        showIfQuestionId: "been",
        showIfValue: "true",
        all,
      }),
    ).toBe("self");
  });

  test("a condition needs a value to match", () => {
    expect(
      checkCondition({
        questionId: "why",
        showIfQuestionId: "been",
        showIfValue: "",
        all,
      }),
    ).toBe("needs-value");
  });

  test("pointing at a question that doesn't exist is refused", () => {
    expect(
      checkCondition({
        questionId: "why",
        showIfQuestionId: "ghost",
        showIfValue: "true",
        all,
      }),
    ).toBe("missing");
  });

  test("chains are refused from both directions", () => {
    // Depending on something already conditional…
    expect(
      checkCondition({
        questionId: "why",
        showIfQuestionId: "which",
        showIfValue: "x",
        all,
      }),
    ).toBe("chain");
    // …and making something conditional that others already depend on.
    expect(
      checkCondition({
        questionId: "been",
        showIfQuestionId: "why",
        showIfValue: "x",
        all: [...all, q("why")],
      }),
    ).toBe("chain");
  });

  test("a plain one-level condition is accepted", () => {
    expect(
      checkCondition({
        questionId: "why",
        showIfQuestionId: "been",
        showIfValue: "true",
        all: [...all, q("why")],
      }),
    ).toBeNull();
  });
});
