/**
 * A full-width notice strip at the top of the app shell.
 *
 * The shell had three of these (privacy mode, impersonation, feature preview),
 * each an independently hand-rolled `<Group>` with the same inline background
 * and radius. Adding a fourth for the passkey nag would have made four copies
 * of the same eight lines, so they're one component now.
 *
 * Message on the left, an optional control on the right.
 */
import { Group, Text } from "@mantine/core";
import type { ReactNode } from "react";

export type ShellBannerProps = {
  /** Mantine colour key; the strip uses its `-light` shade. */
  color: "orange" | "grape" | "blue";
  /**
   * Announce to screen readers when it appears. Use for a change in session
   * STATE the user needs to notice (privacy mode started, impersonation
   * started) — not for standing advice, which would be re-announced on every
   * navigation and become noise.
   */
  announce?: boolean;
  /** The message. */
  children: ReactNode;
  /** Optional right-hand control (a button, a form). */
  action?: ReactNode;
};

export function ShellBanner({
  color,
  announce = false,
  children,
  action,
}: ShellBannerProps) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      mb="md"
      px="md"
      py="xs"
      // Not an <output> (that's for form results) — this is a session-status
      // strip, and role="status" is what makes a screen reader announce it.
      role={announce ? "status" : undefined}
      style={{
        background: `var(--mantine-color-${color}-light)`,
        borderRadius: "var(--mantine-radius-sm)",
      }}
    >
      <Text size="sm">{children}</Text>
      {action ?? null}
    </Group>
  );
}
