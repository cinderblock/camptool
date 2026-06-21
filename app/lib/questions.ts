/**
 * Questionnaire — pure, client-safe helpers shared by the officer admin
 * (`/questions`) and the wizard's questionnaire step. The DB side lives in
 * questions.server.ts; the schema (db/schema/question.ts) owns the canonical
 * column types. Keep this `QuestionType` union in sync with that one.
 */
export type QuestionType =
  | "short_text"
  | "long_text"
  | "single_select"
  | "multi_select"
  | "number"
  | "boolean"
  | "date"
  | "consent"
  // "Smart" types that wire to real data:
  | "event_date" // a date bounded to the weeks around the event
  | "event_range" // arrival + departure picked on one event calendar
  | "invited_by"; // pre-fills who invited you from the invite tree

export type QuestionAudience = "all" | "returning" | "recruit";

/** Which side of the wizard's "Bringing" step a question shows on. */
export type QuestionPlacement = "before" | "after";

export const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: "short_text", label: "Short text" },
  { value: "long_text", label: "Long text (paragraph)" },
  { value: "single_select", label: "Single choice" },
  { value: "multi_select", label: "Multiple choice" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Yes / no" },
  { value: "date", label: "Date" },
  { value: "consent", label: "Agreement (must check)" },
  { value: "event_date", label: "Date (near the event)" },
  { value: "event_range", label: "Arrival & departure" },
  { value: "invited_by", label: "Who invited you (auto-fills)" },
];

export const QUESTION_AUDIENCES: { value: QuestionAudience; label: string }[] =
  [
    { value: "all", label: "Everyone" },
    { value: "returning", label: "Returning members" },
    { value: "recruit", label: "Recruits / prospective" },
  ];

export const QUESTION_PLACEMENTS: {
  value: QuestionPlacement;
  label: string;
}[] = [
  { value: "before", label: "Before “Bringing”" },
  { value: "after", label: "After “Bringing”" },
];

export function questionTypeLabel(type: string): string {
  return QUESTION_TYPES.find((t) => t.value === type)?.label ?? type;
}

export function audienceLabel(audience: string): string {
  return (
    QUESTION_AUDIENCES.find((a) => a.value === audience)?.label ?? audience
  );
}

export function isSelectType(type: string): boolean {
  return type === "single_select" || type === "multi_select";
}

/** Parse a question's stored `options` JSON (a string[] for select types). */
export function parseOptions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

/** A multi_select answer value is a JSON array of the chosen options. */
export function parseMultiValue(raw: string | null | undefined): string[] {
  return parseOptions(raw);
}

export type EventRange = { arrival: string | null; departure: string | null };

/** An `event_range` answer is stored as JSON `{arrival,departure}` (each a
 * `YYYY-MM-DD` string or null). Tolerant of empty/garbage → both null. */
export function parseEventRange(raw: string | null | undefined): EventRange {
  if (!raw) return { arrival: null, departure: null };
  try {
    const v = JSON.parse(raw);
    const pick = (x: unknown) => (typeof x === "string" && x ? x : null);
    return { arrival: pick(v?.arrival), departure: pick(v?.departure) };
  } catch {
    return { arrival: null, departure: null };
  }
}

/** Serialize an event range for storage; an all-null range stores as "" (clear). */
export function stringifyEventRange(r: EventRange): string {
  if (!r.arrival && !r.departure) return "";
  return JSON.stringify({ arrival: r.arrival, departure: r.departure });
}
