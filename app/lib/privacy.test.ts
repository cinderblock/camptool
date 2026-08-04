import { describe, expect, test } from "bun:test";
import { classifyKey, parsePrivacyMode, serializePrivacyMode } from "./privacy";
import {
  type PersonRow,
  buildPrivacyLens,
  fakePerson,
  redact,
} from "./privacy.server";

const PEOPLE: PersonRow[] = [
  { name: "Sarah Chen", email: "sarah@real.example", playaName: "Wingnut" },
  { name: "Cameron Tacklind", email: "cam@real.example", playaName: null },
];
const GUESTS: PersonRow[] = [
  { name: "Marcus Hollis", email: "marcus@real.example" },
];

function lens(opts: { keepSelf?: boolean } = {}) {
  return buildPrivacyLens({
    mode: { on: true, keepSelf: opts.keepSelf ?? false },
    people: PEOPLE,
    guests: GUESTS,
    self: {
      name: "Cameron Tacklind",
      email: "cam@real.example",
      playaName: null,
    },
  });
}

describe("cookie", () => {
  test("round-trips", () => {
    for (const m of [
      { on: false, keepSelf: false },
      { on: true, keepSelf: false },
      { on: true, keepSelf: true },
    ]) {
      expect(parsePrivacyMode(serializePrivacyMode(m))).toEqual(m);
    }
  });

  test("absent or junk cookie is off", () => {
    expect(parsePrivacyMode(null).on).toBe(false);
    expect(parsePrivacyMode("yes-please").on).toBe(false);
  });
});

describe("field classification", () => {
  test("unambiguous PII keys", () => {
    expect(classifyKey("email")).toBe("email");
    expect(classifyKey("placementContactEmail")).toBe("email");
    expect(classifyKey("playaName")).toBe("playa");
    expect(classifyKey("discordUsername")).toBe("handle");
    expect(classifyKey("placementContactPhone")).toBe("phone");
  });

  test("person-ish *Name keys, minus the safe list", () => {
    expect(classifyKey("subjectName")).toBe("person");
    expect(classifyKey("reporterName")).toBe("person");
    expect(classifyKey("presenterName")).toBe("person");
    expect(classifyKey("campName")).toBeNull();
    expect(classifyKey("offeringName")).toBeNull();
    expect(classifyKey("structureName")).toBeNull();
  });

  test("bare `name` needs a personhood signal on the record", () => {
    expect(classifyKey("name", { email: "x", name: "y" })).toBe("person");
    expect(classifyKey("name", { userId: "u1", name: "y" })).toBe("person");
    // A shade structure or inventory item HAS an owner but IS not a person.
    expect(
      classifyKey("name", { ownerMembershipId: "m1", name: "y" }),
    ).toBeNull();
    expect(classifyKey("name", { notes: "n", name: "Big Shade" })).toBeNull();
  });

  test("ids, counts and dates are never PII", () => {
    for (const k of ["id", "campId", "membershipId", "year", "createdAt"]) {
      expect(classifyKey(k)).toBeNull();
    }
  });
});

describe("pseudonyms", () => {
  test("deterministic", () => {
    expect(fakePerson("Sarah Chen")).toBe(fakePerson("Sarah Chen"));
  });

  test("preserves word count", () => {
    expect(fakePerson("Sarah Chen").split(" ")).toHaveLength(2);
    expect(fakePerson("Prince").split(" ")).toHaveLength(1);
  });

  test("per-word seeding keeps a bare first name consistent", () => {
    expect(fakePerson("Sarah Chen").startsWith(`${fakePerson("Sarah")} `)).toBe(
      true,
    );
  });

  test("different people get different names", () => {
    expect(fakePerson("Sarah Chen")).not.toBe(fakePerson("Marcus Hollis"));
  });
});

describe("redact", () => {
  test("is a pass-through when privacy is off", () => {
    const data = {
      members: [{ name: "Sarah Chen", email: "sarah@real.example" }],
    };
    expect(redact(null, data)).toBe(data);
  });

  test("swaps PII but leaves structure, ids and non-PII names alone", () => {
    const out = redact(lens(), {
      campName: "Math Camp",
      year: 2026,
      members: [
        {
          memberId: "m1",
          userId: "u1",
          name: "Sarah Chen",
          email: "sarah@real.example",
          playaName: "Wingnut",
          role: "officer",
        },
      ],
      structures: [{ id: "s1", name: "Big Shade", ownerMembershipId: "m1" }],
    });

    expect(out.campName).toBe("Math Camp");
    expect(out.year).toBe(2026);
    expect(out.structures[0]?.name).toBe("Big Shade");

    const m = out.members[0];
    expect(m?.memberId).toBe("m1");
    expect(m?.userId).toBe("u1");
    expect(m?.role).toBe("officer");
    expect(m?.name).not.toBe("Sarah Chen");
    expect(m?.email).not.toContain("real.example");
    expect(m?.playaName).not.toBe("Wingnut");
  });

  test("the same person is the same pseudonym across payload shapes", () => {
    const l = lens();
    const a = redact(l, { members: [{ name: "Sarah Chen", userId: "u1" }] });
    const b = redact(l, { presenters: [{ presenterName: "Sarah Chen" }] });
    expect(a.members[0]?.name).toBe(b.presenters[0]?.presenterName);
  });

  test("a linked email reads as the same fake person", () => {
    const out = redact(lens(), {
      members: [{ name: "Sarah Chen", email: "sarah@real.example" }],
    });
    const local = out.members[0]?.email?.split("@")[0];
    expect(local).toBe(
      out.members[0]?.name?.toLowerCase().replace(/\s+/g, "."),
    );
  });

  test("free text keeps its prose but loses the real names", () => {
    const out = redact(lens(), {
      notes: [{ note: "Ask Sarah about the shade before Marcus arrives." }],
    });
    const note = out.notes[0]?.note ?? "";
    expect(note).toContain("about the shade before");
    expect(note).not.toContain("Sarah");
    expect(note).not.toContain("Marcus");
  });

  test("emails buried in free text are scrubbed too", () => {
    const out = redact(lens(), { body: "reach me at sarah@real.example ok?" });
    expect(out.body).not.toContain("sarah@real.example");
    expect(out.body).toContain("reach me at");
  });

  test("keepSelf leaves the viewer alone, in fields and in prose", () => {
    const out = redact(lens({ keepSelf: true }), {
      user: { name: "Cameron Tacklind", email: "cam@real.example" },
      members: [{ name: "Sarah Chen", userId: "u1" }],
      body: "Cameron and Sarah are driving up together.",
    });
    expect(out.user.name).toBe("Cameron Tacklind");
    expect(out.user.email).toBe("cam@real.example");
    expect(out.members[0]?.name).not.toBe("Sarah Chen");
    expect(out.body).toContain("Cameron");
    expect(out.body).not.toContain("Sarah");
  });

  test("does not mutate the input", () => {
    const data = { members: [{ name: "Sarah Chen", userId: "u1" }] };
    redact(lens(), data);
    expect(data.members[0]?.name).toBe("Sarah Chen");
  });

  test("nulls, dates and numbers survive", () => {
    const when = new Date("2026-08-03T00:00:00Z");
    const out = redact(lens(), {
      members: [
        { name: null, email: null, userId: "u1", createdAt: when, dues: 120 },
      ],
    });
    expect(out.members[0]?.name).toBeNull();
    expect(out.members[0]?.createdAt).toBe(when);
    expect(out.members[0]?.dues).toBe(120);
  });
});
