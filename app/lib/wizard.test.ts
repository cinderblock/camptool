/**
 * What the onboarding wizard asks, and — more importantly — what it stops
 * asking.
 *
 * There are two ask systems in this app: the dashboard to-do list (`asks.ts`,
 * which has always gated on `attending()`) and the wizard's own schedule
 * (`wizard.ts`, which didn't). They disagreed about the same person: someone
 * who answered "not this year" was still walked through what tent they were
 * bringing. These tests pin the agreement.
 */
import { describe, expect, test } from "bun:test";
import { ASKS, scheduleAsks } from "./wizard";

const ON = {
  bringing: "on",
  onboarding: "on",
} as const;

const keys = (rsvp: string | null) =>
  scheduleAsks({
    role: "member",
    weeksUntilEvent: 4,
    featureStates: ON,
    rsvp,
  }).map((a) => a.key);

describe("scheduleAsks and the RSVP", () => {
  test("someone coming gets the full arc", () => {
    expect(keys("coming")).toEqual([
      "profile",
      "questionnaire",
      "bringing",
      "extras",
      "sharing",
      "checklist",
    ]);
  });

  test("someone not coming is asked nothing about gear", () => {
    const got = keys("not_coming");
    expect(got).toEqual(["profile", "questionnaire"]);
    for (const gone of ["bringing", "extras", "sharing", "checklist"]) {
      expect(got).not.toContain(gone);
    }
  });

  test("the questionnaire survives, because it holds the RSVP itself", () => {
    // Drop this and someone who said "not coming" by mistake could never
    // change their mind from the wizard.
    expect(keys("not_coming")).toContain("questionnaire");
  });

  test("profile survives — a name is worth having either way", () => {
    expect(keys("not_coming")).toContain("profile");
  });

  test("an unanswered RSVP is not a no", () => {
    // "unknown" and null both mean they haven't said. Treating that as "not
    // coming" would hide the very questions that get them to answer.
    expect(keys("unknown")).toEqual(keys("coming"));
    expect(keys(null)).toEqual(keys("coming"));
  });

  test("maybe is treated as coming", () => {
    expect(keys("maybe")).toEqual(keys("coming"));
  });

  test("every coming-only ask is one that needs them there", () => {
    // Guards the flags themselves: profile and questionnaire must never be
    // marked coming-only, or a "not coming" answer becomes unreachable.
    const comingOnly = ASKS.filter((a) => a.comingOnly).map((a) => a.key);
    expect(comingOnly).not.toContain("profile");
    expect(comingOnly).not.toContain("questionnaire");
    expect(comingOnly.length).toBeGreaterThan(0);
  });
});
