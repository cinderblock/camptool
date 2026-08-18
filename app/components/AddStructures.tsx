import {
  Button,
  Group,
  NumberInput,
  Popover,
  Stack,
  Text,
} from "@mantine/core";
import { useState } from "react";
import { CAMPER_KIND_GROUPS, type Kind, ShapeSwatch } from "~/lib/structures";

export type AddSize = { width?: number; height?: number };

/**
 * The camper-facing "add an item" palette (Bringing page + onboarding wizard).
 * Shows only personal kinds (no communal infrastructure), under the same
 * category headings the map legend uses, because ~30 buttons in one row is a
 * wall nobody reads. For a sizable kind it pops a small size prompt so a camper
 * picks real dimensions instead of silently accepting the default footprint;
 * rigid kinds (fixed size) add immediately.
 */
export function AddStructures({
  onAdd,
  disabled,
  bannedKinds,
}: {
  onAdd: (kind: string, size?: AddSize) => void;
  disabled?: boolean;
  /** Kinds disallowed this edition — dropped from the palette. */
  bannedKinds?: string[];
}) {
  const banned = new Set(bannedKinds);
  const groups = CAMPER_KIND_GROUPS.map((grp) => ({
    ...grp,
    kinds: grp.kinds.filter((k) => !banned.has(k.value)),
  })).filter((grp) => grp.kinds.length > 0);
  return (
    <Stack gap={10}>
      {groups.map((grp) => (
        <div key={grp.group}>
          <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb={6}>
            {grp.group}
          </Text>
          <Group gap="xs">
            {grp.kinds.map((k) => (
              <AddButton
                key={k.value}
                kind={k}
                onAdd={onAdd}
                disabled={disabled}
              />
            ))}
          </Group>
        </div>
      ))}
    </Stack>
  );
}

function AddButton({
  kind,
  onAdd,
  disabled,
}: {
  kind: Kind;
  onAdd: (kind: string, size?: AddSize) => void;
  disabled?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const [width, setWidth] = useState<number | string>(kind.w);
  const [height, setHeight] = useState<number | string>(kind.h);

  // Rigid kinds have a fixed footprint — nothing to ask, add straight away.
  if (kind.rigid) {
    return (
      <Button
        size="xs"
        variant="default"
        disabled={disabled}
        leftSection={<ShapeSwatch kind={kind} size={14} />}
        onClick={() => onAdd(kind.value)}
      >
        {kind.label}
      </Button>
    );
  }

  const minLen = kind.vehicle ? 6 : 1;
  const confirm = () => {
    onAdd(kind.value, {
      width: kind.vehicle ? undefined : Math.max(1, Number(width) || kind.w),
      height: Math.max(minLen, Number(height) || kind.h),
    });
    setOpened(false);
  };

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      withArrow
      position="bottom-start"
      trapFocus
      shadow="md"
    >
      <Popover.Target>
        <Button
          size="xs"
          variant="default"
          disabled={disabled}
          leftSection={<ShapeSwatch kind={kind} size={14} />}
          onClick={() => setOpened((o) => !o)}
        >
          {kind.label}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="xs" fw={600}>
            How big is your {kind.label.toLowerCase()}? (feet)
          </Text>
          <Group gap="xs" align="flex-end">
            {kind.vehicle ? null : (
              <NumberInput
                size="xs"
                label="Width"
                w={84}
                min={1}
                value={width}
                onChange={setWidth}
              />
            )}
            <NumberInput
              size="xs"
              label={kind.vehicle ? "Length" : "Depth"}
              w={84}
              min={minLen}
              value={height}
              onChange={setHeight}
            />
            <Button size="xs" onClick={confirm}>
              Add
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
