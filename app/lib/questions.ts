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
  | "consent";

export type QuestionAudience = "all" | "returning" | "recruit";

export const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: "short_text", label: "Short text" },
  { value: "long_text", label: "Long text (paragraph)" },
  { value: "single_select", label: "Single choice" },
  { value: "multi_select", label: "Multiple choice" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Yes / no" },
  { value: "date", label: "Date" },
  { value: "consent", label: "Agreement (must check)" },
];

export const QUESTION_AUDIENCES: { value: QuestionAudience; label: string }[] =
  [
    { value: "all", label: "Everyone" },
    { value: "returning", label: "Returning members" },
    { value: "recruit", label: "Recruits / prospective" },
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
