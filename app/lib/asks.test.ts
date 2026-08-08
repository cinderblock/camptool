import { describe, expect, test } from "bun:test";
import {
  ASKS,
  type AskContext,
  type AskSnapshot,
  IMPORTANCE_RANK,
  askProgress,
  outstandingAsks,
} from "./asks";

/** A camper who owes nothing: every predicate satisfied. */
const settled: AskSnapshot = {
  role: "member",
  hasName: true,
  hasPlayaName: true,
  rsvp: "coming",
  hasArrivalDate: true,
  hasDepartureDate: true,
  needsSetupPass: false,
  unansweredRequiredQuestions: 0,
  bringingCount: 1,
  unplacedCount: 0,
  domicilesWithoutOccupants: 0,
  checklistRemaining: 0,
  hasTicket: true,
  ticketRequested: false,
  ticketsAwaitingPurchase: 0,
  hasSetupPassRow: false,
  fuelDeclared: true,
  duesOwedCents: 0,
  discordLinked: true,
  hasPasskey: true,
  dismissed: {},
  acknowledged: { extras: true },
};

/** Everything on, and far enough out that every seasonal ask is open. */
const ctx: AskContext = {
  weeksUntilEvent: 4,
  featureStates: {
    questions: "on",
    bringing: "on",
    map: "on",
    tickets: "on",
    passes: "on",
    fuel: "on",
    onboarding: "on",
    dues: "on",
  },
};

const snap = (over: Partial<AskSnapshot> = {}): AskSnapshot => ({
  ...settled,
  ...over,
});
const keys = (s: AskSnapshot, c: AskContext = ctx) =>
  outstandingAsks(s, c).map((a) => a.key);

describe("the settled baseline", () => {
  test("someone who has done everything owes nothing", () => {
    expect(keys(settled)).toEqual([]);
  });

  test("a brand-new camper owes a lot", () => {
    const fresh = snap({
      hasName: false,
      hasPlayaName: false,
      rsvp: "unknown",
      hasArrivalDate: false,
      hasDepartureDate: false,
      unansweredRequiredQuestions: 3,
      bringingCount: 0,
      checklistRemaining: 5,
      hasTicket: false,
      fuelDeclared: false,
      duesOwedCents: 12000,
      discordLinked: false,
      acknowledged: {},
    });
    // This is the "bailed out of the wizard" case: nothing was resolved, so
    // everything relevant should still be visible.
    expect(keys(fresh)).toContain("rsvp");
    expect(keys(fresh)).toContain("questionnaire");
    expect(keys(fresh)).toContain("dues");
    expect(keys(fresh).length).toBeGreaterThan(6);
  });
});

describe("required beats everything", () => {
  test("required asks sort ahead of recommended and optional", () => {
    const out = outstandingAsks(
      snap({
        rsvp: "unknown",
        discordLinked: false,
        hasName: false,
        unansweredRequiredQuestions: 1,
      }),
      ctx,
    );
    // Compare by rank, not alphabetically — "optional" < "required" as strings,
    // which is the opposite of the order that matters.
    const ranks = out.map((a) => IMPORTANCE_RANK[a.importance]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(out[0]?.importance).toBe("required");
  });

  test("a required ask cannot be dismissed", () => {
    const s = snap({
      rsvp: "unknown",
      dismissed: { rsvp: true, questionnaire: true },
      unansweredRequiredQuestions: 2,
    });
    expect(keys(s)).toContain("rsvp");
    expect(keys(s)).toContain("questionnaire");
  });

  test("a recommended ask can be", () => {
    expect(keys(snap({ fuelDeclared: false }))).toContain("fuel");
    expect(
      keys(snap({ fuelDeclared: false, dismissed: { fuel: true } })),
    ).not.toContain("fuel");
  });

  test("dismissible flag matches importance", () => {
    for (const a of outstandingAsks(snap({ rsvp: "unknown" }), ctx)) {
      expect(a.dismissible).toBe(a.importance !== "required");
    }
  });
});

// The regression this whole design exists to fix.
describe("satisfaction is re-derived, not remembered", () => {
  test("a new required question re-nags someone who already walked past it", () => {
    const finished = snap({
      acknowledged: { questionnaire: true, extras: true },
    });
    expect(keys(finished)).not.toContain("questionnaire");
    const officerAddedOne = snap({
      acknowledged: { questionnaire: true, extras: true },
      unansweredRequiredQuestions: 1,
    });
    expect(keys(officerAddedOne)).toContain("questionnaire");
  });

  test("acknowledgement-only asks still respect their record", () => {
    expect(keys(snap({ acknowledged: {} }))).toContain("extras");
    expect(keys(snap({ acknowledged: { extras: true } }))).not.toContain(
      "extras",
    );
  });
});

describe("someone who isn't coming", () => {
  const away = snap({
    rsvp: "not_coming",
    hasArrivalDate: false,
    hasDepartureDate: false,
    bringingCount: 0,
    unplacedCount: 3,
    checklistRemaining: 4,
    hasTicket: false,
    ticketRequested: false,
    fuelDeclared: false,
    duesOwedCents: 50000,
    needsSetupPass: true,
    hasSetupPassRow: false,
  });

  test("is not chased for logistics", () => {
    const k = keys(away);
    for (const q of [
      "stay_dates",
      "bringing",
      "place_on_map",
      "ticket",
      "setup_pass",
      "fuel",
      "checklist",
      "dues",
    ]) {
      expect(k).not.toContain(q);
    }
  });

  test("but a ticket already assigned to them still needs settling", () => {
    // They hold a real ticket the camp paid for; walking away silently would
    // strand it, so this one deliberately ignores the RSVP.
    expect(
      keys(snap({ rsvp: "not_coming", ticketsAwaitingPurchase: 1 })),
    ).toContain("ticket_purchased");
  });
});

describe("feature gating", () => {
  test("an ask for a feature the camp turned off is never shown", () => {
    const s = snap({ fuelDeclared: false, duesOwedCents: 9900 });
    expect(keys(s)).toContain("fuel");
    expect(
      keys(s, { ...ctx, featureStates: { ...ctx.featureStates, fuel: "off" } }),
    ).not.toContain("fuel");
  });

  test("preview features are officers-only", () => {
    const s = snap({ fuelDeclared: false });
    const preview = {
      ...ctx,
      featureStates: { ...ctx.featureStates, fuel: "preview" as const },
    };
    expect(keys({ ...s, role: "member" }, preview)).not.toContain("fuel");
    expect(keys({ ...s, role: "officer" }, preview)).toContain("fuel");
  });

  test("core asks survive with no feature states at all", () => {
    expect(keys(snap({ rsvp: "unknown" }), { weeksUntilEvent: 4 })).toContain(
      "rsvp",
    );
  });
});

describe("season windows", () => {
  test("gear asks stay quiet until the season opens", () => {
    const s = snap({ bringingCount: 0, fuelDeclared: false });
    const early = { ...ctx, weeksUntilEvent: 30 };
    expect(keys(s, early)).not.toContain("bringing");
    expect(keys(s, early)).not.toContain("fuel");
    expect(keys(s, { ...ctx, weeksUntilEvent: 10 })).toContain("bringing");
  });

  test("asks with no window are always open", () => {
    expect(
      keys(snap({ rsvp: "unknown" }), { ...ctx, weeksUntilEvent: 99 }),
    ).toContain("rsvp");
  });
});

describe("setup passes are only asked of early arrivals", () => {
  test("no pass needed when arriving after gates open", () => {
    expect(
      keys(snap({ needsSetupPass: false, hasSetupPassRow: false })),
    ).not.toContain("setup_pass");
  });

  test("asked when arriving early without one", () => {
    expect(
      keys(snap({ needsSetupPass: true, hasSetupPassRow: false })),
    ).toContain("setup_pass");
  });

  test("satisfied once requested", () => {
    expect(
      keys(snap({ needsSetupPass: true, hasSetupPassRow: true })),
    ).not.toContain("setup_pass");
  });
});

describe("catalog integrity", () => {
  test("keys are unique", () => {
    expect(new Set(ASKS.map((a) => a.key)).size).toBe(ASKS.length);
  });

  // An ask with nowhere to act is noise — this is a stated rule in the plan.
  test("every ask has a route", () => {
    for (const a of ASKS) expect(a.route.startsWith("/")).toBe(true);
  });

  test("every ask has a distinct label and a hint", () => {
    expect(new Set(ASKS.map((a) => a.label)).size).toBe(ASKS.length);
    for (const a of ASKS) expect(a.hint.length).toBeGreaterThan(0);
  });
});

describe("passkey ask", () => {
  test("is outstanding until a passkey exists", () => {
    expect(
      outstandingAsks(snap({ hasPasskey: false }), ctx).map((a) => a.key),
    ).toContain("passkey");
    expect(
      outstandingAsks(snap({ hasPasskey: true }), ctx).map((a) => a.key),
    ).not.toContain("passkey");
  });

  test("cannot be dismissed — it stays until actually done", () => {
    // The banner is snoozeable; the to-do row is not. Marking it skipped in
    // wizard_ask must NOT silence it, or "persistent until they do" is a lie.
    const s = snap({ hasPasskey: false, dismissed: { passkey: true } });
    expect(outstandingAsks(s, ctx).map((a) => a.key)).toContain("passkey");
  });

  test("is not gated on a camp feature", () => {
    // Every account wants a credential regardless of which features the camp
    // has switched on, so it must survive everything being off.
    const s = snap({ hasPasskey: false });
    const keys = outstandingAsks(s, { ...ctx, featureStates: {} }).map(
      (a) => a.key,
    );
    expect(keys).toContain("passkey");
  });

  test("applies year-round, not just close to the event", () => {
    const s = snap({ hasPasskey: false });
    const keys = outstandingAsks(s, { ...ctx, weeksUntilEvent: 52 }).map(
      (a) => a.key,
    );
    expect(keys).toContain("passkey");
  });
});

describe("askProgress", () => {
  test("reports every scheduled ask with its state, not just what's left", () => {
    const s = snap({ rsvp: "unknown" });
    const prog = askProgress(s, ctx);
    expect(prog.length).toBeGreaterThan(outstandingAsks(s, ctx).length);
    expect(prog.find((p) => p.key === "rsvp")?.done).toBe(false);
    expect(prog.find((p) => p.key === "fuel")?.done).toBe(true);
  });

  test("hides asks that aren't scheduled at all", () => {
    const prog = askProgress(settled, {
      ...ctx,
      featureStates: { ...ctx.featureStates, fuel: "off" },
    });
    expect(prog.map((p) => p.key)).not.toContain("fuel");
  });
});
