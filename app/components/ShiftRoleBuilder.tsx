/**
 * Role-template builder — define a set of shift roles once, in a form, and post
 * them as parallel repeated fields (`shiftRole`, `shiftStaffing`, `shiftCount`,
 * `shiftStart`, `shiftEnd`) that `parseShiftTemplate` in schedule.server.ts
 * reads back.
 *
 * Why it exists: a service that runs every day with several distinct jobs — a
 * prep crew, then cutters, then a big serving push, then cleanup — used to mean
 * adding each role to each day by hand, one submit at a time. Nine days times
 * four roles is 36 submits, which is why nobody ever set one up. The same
 * component drives "create a gathering with these roles" and "stamp these roles
 * onto every day I already have".
 *
 * Deliberately plain inputs, not controlled state per field: the form is the
 * source of truth, so an accidental re-render can't lose half-typed rows. Only
 * the row list itself is state.
 */
import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useState } from "react";
import { STAFFING_OPTIONS } from "~/lib/schedule";

export type RoleDraft = {
  /** Local-only key; never posted. */
  key: string;
  role: string;
  staffing: string;
  count: string;
  startTime: string;
  endTime: string;
};

export function emptyRole(): RoleDraft {
  return {
    key: crypto.randomUUID(),
    role: "",
    staffing: "needed",
    count: "",
    startTime: "",
    endTime: "",
  };
}

/**
 * @param rows       the current drafts
 * @param onChange   replace the draft list
 * @param maxRoles   guard matching MAX_TEMPLATE_ROLES on the server
 */
export function ShiftRoleBuilder({
  rows,
  onChange,
  maxRoles = 12,
}: {
  rows: RoleDraft[];
  onChange: (rows: RoleDraft[]) => void;
  maxRoles?: number;
}) {
  const set = (key: string, patch: Partial<RoleDraft>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <Stack gap="xs">
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          No roles yet — one general sign-up sheet per day.
        </Text>
      ) : null}
      {rows.map((r, i) => (
        <Group key={r.key} gap="xs" align="flex-end" wrap="wrap">
          <TextInput
            size="xs"
            name="shiftRole"
            label={i === 0 ? "Role" : undefined}
            placeholder="e.g. Servers"
            style={{ flex: 1, minWidth: 140 }}
            value={r.role}
            onChange={(e) => set(r.key, { role: e.currentTarget.value })}
            maxLength={80}
          />
          <TextInput
            size="xs"
            type="time"
            name="shiftStart"
            label={i === 0 ? "From" : undefined}
            w={110}
            value={r.startTime}
            onChange={(e) => set(r.key, { startTime: e.currentTarget.value })}
          />
          <TextInput
            size="xs"
            type="time"
            name="shiftEnd"
            label={i === 0 ? "To" : undefined}
            w={110}
            value={r.endTime}
            onChange={(e) => set(r.key, { endTime: e.currentTarget.value })}
          />
          <Select
            size="xs"
            w={130}
            label={i === 0 ? "Who's needed" : undefined}
            data={STAFFING_OPTIONS.map((s) => ({
              value: s.value,
              label: s.label,
            }))}
            value={r.staffing}
            onChange={(v) => set(r.key, { staffing: v ?? "open" })}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />
          <input type="hidden" name="shiftStaffing" value={r.staffing} />
          <NumberInput
            size="xs"
            w={90}
            min={1}
            label={i === 0 ? "How many" : undefined}
            placeholder="—"
            disabled={r.staffing !== "needed"}
            value={r.count}
            onChange={(v) => set(r.key, { count: String(v ?? "") })}
          />
          {/* Posted separately so a disabled NumberInput still sends a slot,
              keeping every parallel array the same length. */}
          <input
            type="hidden"
            name="shiftCount"
            value={r.staffing === "needed" ? r.count : ""}
          />
          <ActionIcon
            variant="subtle"
            color="red"
            aria-label={`Remove role ${r.role || i + 1}`}
            onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
          >
            ×
          </ActionIcon>
        </Group>
      ))}
      <Group gap="xs">
        <Button
          size="compact-xs"
          variant="light"
          disabled={rows.length >= maxRoles}
          onClick={() => onChange([...rows, emptyRole()])}
        >
          + Add a role
        </Button>
        {rows.length >= maxRoles ? (
          <Text size="xs" c="dimmed">
            That's the maximum of {maxRoles} roles.
          </Text>
        ) : null}
      </Group>
    </Stack>
  );
}
