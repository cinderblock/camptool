import dayjs from "dayjs";

// Mantine's date pickers (8+) speak local wall-clock strings with no zone:
// "2026-11-07" from DateInput, "2026-11-07 13:05:00" from DateTimePicker.
// `new Date()` on those is wrong: a date-only string parses as UTC midnight
// (the previous day in the Americas), and a server would read a date-time in
// its own zone. dayjs parses both as the browser's local time.

/** A picker value as a Date in the browser's zone, or null when empty. */
export function pickerValueToDate(value: string | null): Date | null {
  return value ? dayjs(value).toDate() : null;
}

/** A picker value as the ISO instant it means in the browser's zone, or "". */
export function pickerValueToIso(value: string | null): string {
  return value ? dayjs(value).toISOString() : "";
}
