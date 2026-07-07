import {
  Checkbox,
  TextInput,
  type TextInputProps,
  Textarea,
} from "@mantine/core";
import { useState } from "react";
import { announce } from "~/components/Announcer";

/**
 * "Playa name" is Burning Man jargon — meaningless to first-timers, so the
 * field only appears once the person says they've been. Anyone who already has
 * a playa name saved sees the field straight away. Shared by the public
 * application form and the wizard's profile step. (Event-layer copy; revisit
 * when the event theming layer peels out.)
 *
 * On the application form, someone who's been before almost certainly camped
 * somewhere — `withPreviousCamp` also reveals fields asking where and how it
 * went, so officers reviewing the application know what the applicant is
 * coming from (submitted as `previousCamp` / `previousCampNotes`).
 */
export function PlayaNameField({
  defaultValue,
  withPreviousCamp = false,
  ...inputProps
}: TextInputProps & { withPreviousCamp?: boolean }) {
  const [beenBefore, setBeenBefore] = useState(Boolean(defaultValue));
  return (
    <>
      <Checkbox
        label="I've been to Burning Man before"
        description="No worries if not — first-timers are welcome."
        checked={beenBefore}
        onChange={(e) => {
          const checked = e.currentTarget.checked;
          setBeenBefore(checked);
          // The fields appear/disappear silently otherwise.
          if (checked)
            announce(
              withPreviousCamp
                ? "Playa name and previous camp fields added below."
                : "Playa name field added below.",
            );
        }}
      />
      {beenBefore ? (
        <>
          <TextInput
            label="Playa name"
            description="Optional — the nickname you go by at the event."
            placeholder="Dusty"
            defaultValue={defaultValue}
            {...inputProps}
          />
          {withPreviousCamp ? (
            <>
              <TextInput
                name="previousCamp"
                label="Previous camp"
                description="Optional — who did you camp with before? Solo or freecamping counts too."
                placeholder="e.g. Camp Contact"
              />
              <Textarea
                name="previousCampNotes"
                label="How was it — and why a new camp?"
                description="Optional — what you liked (or didn't) about your previous camp, and/or what you're hoping to find here."
                autosize
                minRows={2}
              />
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
