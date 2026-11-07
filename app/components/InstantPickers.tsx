import {
  DateInput,
  type DateInputProps,
  DateTimePicker,
  type DateTimePickerProps,
} from "@mantine/dates";
import dayjs from "dayjs";
import { useState } from "react";
import { pickerValueToIso } from "~/lib/date-value";

// Uncontrolled date pickers inside a plain <form>. Mantine 8+ submits a named
// picker as a zone-less local string ("2026-11-07 13:05:00"), which the server
// would read in its own zone. These submit `name` as the ISO instant the value
// means in the browser's zone, as Mantine 7 did.

type InstantProps<P> = Omit<
  P,
  "name" | "value" | "defaultValue" | "onChange"
> & {
  name: string;
  defaultValue?: Date | null;
};

export function InstantDateInput({
  name,
  defaultValue,
  ...props
}: InstantProps<DateInputProps>) {
  const [value, setValue] = useState<string | null>(() =>
    defaultValue ? dayjs(defaultValue).format("YYYY-MM-DD") : null,
  );
  return (
    <>
      <DateInput {...props} value={value} onChange={setValue} />
      <input type="hidden" name={name} value={pickerValueToIso(value)} />
    </>
  );
}

export function InstantDateTimePicker({
  name,
  defaultValue,
  ...props
}: InstantProps<DateTimePickerProps>) {
  const [value, setValue] = useState<string | null>(() =>
    defaultValue ? dayjs(defaultValue).format("YYYY-MM-DD HH:mm:ss") : null,
  );
  return (
    <>
      <DateTimePicker {...props} value={value} onChange={setValue} />
      <input type="hidden" name={name} value={pickerValueToIso(value)} />
    </>
  );
}
