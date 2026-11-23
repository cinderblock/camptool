import { Checkbox, TextInput, type TextInputProps } from "@mantine/core";
import { useState } from "react";
import { announce } from "~/components/Announcer";
import { isBurningMan } from "~/lib/events";

/**
 * Event-aware nickname field shared by the public application form and the
 * guided setup profile step.
 *
 * At Burning Man, "Playa name" is event jargon — meaningless to first-timers,
 * so the field only appears once the person says they've been (or already has
 * one saved). For other events, show a plain optional camp nickname field
 * without asking about Burning Man.
 */
export function PlayaNameField({
  event,
  defaultValue,
  ...inputProps
}: TextInputProps & { event?: string | null }) {
  const [beenBefore, setBeenBefore] = useState(Boolean(defaultValue));
  if (!isBurningMan(event)) {
    return (
      <TextInput
        label="Camp nickname"
        placeholder="Optional"
        defaultValue={defaultValue}
        {...inputProps}
      />
    );
  }
  return (
    <>
      <Checkbox
        label="I've been to Burning Man before"
        checked={beenBefore}
        onChange={(e) => {
          const checked = e.currentTarget.checked;
          setBeenBefore(checked);
          // The field appears/disappears silently otherwise.
          if (checked) announce("Playa name field added below.");
        }}
      />
      {beenBefore ? (
        <TextInput
          label="Playa name"
          placeholder="Optional"
          defaultValue={defaultValue}
          {...inputProps}
        />
      ) : null}
    </>
  );
}
