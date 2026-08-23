import { describe, expect, test } from "bun:test";
import {
  cadenceRule,
  isMeetingCadence,
  joinLabel,
  meetingDates,
  meetingProvider,
  normalizeRoomUrl,
} from "./meetings";
import { datesEvery } from "./schedule";

describe("meetingProvider", () => {
  test("names Discord from a copied voice-channel link", () => {
    const p = meetingProvider(
      "https://discord.com/channels/123456789/987654321",
    );
    expect(p.key).toBe("discord");
    expect(p.place).toBe("voice channel");
  });

  test("matches a subdomain of a known host", () => {
    expect(meetingProvider("https://us02web.zoom.us/j/12345").key).toBe("zoom");
    expect(meetingProvider("https://canary.discord.com/channels/1/2").key).toBe(
      "discord",
    );
  });

  test("does not match a lookalike host", () => {
    expect(meetingProvider("https://notdiscord.com/channels/1/2").key).toBe(
      "link",
    );
    expect(meetingProvider("https://zoom.us.evil.example/j/1").key).toBe(
      "link",
    );
  });

  test("falls back to a generic room for anything unrecognized or absent", () => {
    expect(meetingProvider("https://talk.mathcamp.us/room").key).toBe("link");
    expect(meetingProvider(null).key).toBe("link");
    expect(meetingProvider("not a url").key).toBe("link");
  });
});

describe("normalizeRoomUrl", () => {
  test("adds a missing scheme", () => {
    expect(normalizeRoomUrl("discord.com/channels/1/2")).toBe(
      "https://discord.com/channels/1/2",
    );
  });

  test("keeps an http(s) link as-is", () => {
    expect(normalizeRoomUrl("https://meet.jit.si/mathcamp")).toBe(
      "https://meet.jit.si/mathcamp",
    );
  });

  test("refuses a scheme that would make the button an attack", () => {
    expect(normalizeRoomUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeRoomUrl("data:text/html,<b>hi</b>")).toBeNull();
  });

  test("refuses empty or unparsable input", () => {
    expect(normalizeRoomUrl("   ")).toBeNull();
    expect(normalizeRoomUrl("https://")).toBeNull();
  });
});

describe("joinLabel", () => {
  test("uses the camp's own name for the room when it set one", () => {
    expect(joinLabel("https://discord.com/channels/1/2", "the Math Cave")).toBe(
      "Join the Math Cave",
    );
  });

  test("otherwise names the provider and what it is", () => {
    expect(joinLabel("https://discord.com/channels/1/2", null)).toBe(
      "Join the Discord voice channel",
    );
    expect(joinLabel("https://talk.example.com/x", null)).toBe(
      "Join the meeting",
    );
  });
});

describe("datesEvery", () => {
  test("steps weekly and stays inclusive of the end", () => {
    expect(datesEvery("2026-09-01", "2026-09-22", 7)).toEqual([
      "2026-09-01",
      "2026-09-08",
      "2026-09-15",
      "2026-09-22",
    ]);
  });

  test("crosses a month and a leap day without drifting", () => {
    expect(datesEvery("2028-02-22", "2028-03-07", 7)).toEqual([
      "2028-02-22",
      "2028-02-29",
      "2028-03-07",
    ]);
  });

  test("is empty when the range is backwards or the step is nonsense", () => {
    expect(datesEvery("2026-09-22", "2026-09-01", 7)).toEqual([]);
    expect(datesEvery("2026-09-01", "2026-09-22", 0)).toEqual([]);
    expect(datesEvery("2026-09-01", "2026-09-22", -7)).toEqual([]);
  });

  test("caps a runaway range at 100 dates", () => {
    expect(datesEvery("2020-01-01", "2030-01-01", 1)).toHaveLength(100);
  });
});

describe("meetingDates", () => {
  test("'once' yields the single date and ignores a stale end date", () => {
    expect(meetingDates("once", "2026-09-01", "2026-12-31")).toEqual([
      "2026-09-01",
    ]);
  });

  test("fortnightly steps 14 days", () => {
    expect(meetingDates("fortnightly", "2026-09-01", "2026-10-01")).toEqual([
      "2026-09-01",
      "2026-09-15",
      "2026-09-29",
    ]);
  });

  test("a repeating cadence with no end date yields nothing", () => {
    expect(meetingDates("weekly", "2026-09-01", "")).toEqual([]);
  });

  test("an unparsable start yields nothing", () => {
    expect(meetingDates("weekly", "next tuesday", "2026-10-01")).toEqual([]);
  });
});

describe("cadenceRule", () => {
  test("records how a series was made, and nothing for a one-off", () => {
    expect(cadenceRule("weekly", "2026-09-01", "2026-10-01")).toBe(
      "weekly:2026-09-01..2026-10-01",
    );
    expect(cadenceRule("once", "2026-09-01", "2026-10-01")).toBeNull();
  });
});

describe("isMeetingCadence", () => {
  test("accepts the catalog and rejects anything else", () => {
    expect(isMeetingCadence("weekly")).toBe(true);
    expect(isMeetingCadence("monthly")).toBe(false);
  });
});
