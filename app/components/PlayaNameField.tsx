import { Checkbox, TextInput, type TextInputProps } from "@mantine/core";
import { useState } from "react";

/**
 * "Playa name" is Burning Man jargon — meaningless to first-timers, so the
 * field only appears once the person says they've been. Anyone who already has
 * a playa name saved sees the field straight away. Shared by the public
 * application form and the wizard's profile step. (Event-layer copy; revisit
 * when the event theming layer peels out.)
 */
export function PlayaNameField({
  defaultValue,
  ...inputProps
}: TextInputProps) {
  const [beenBefore, setBeenBefore] = useState(Boolean(defaultValue));
  return (
    <>
      <Checkbox
        label="I've been to Burning Man before"
        description="No worries if not — first-timers are welcome."
        checked={beenBefore}
        onChange={(e) => setBeenBefore(e.currentTarget.checked)}
      />
      {beenBefore ? (
        <TextInput
          label="Playa name"
          description="Optional — the nickname you go by at the event."
          placeholder="Dusty"
          defaultValue={defaultValue}
          {...inputProps}
        />
      ) : null}
    </>
  );
}
