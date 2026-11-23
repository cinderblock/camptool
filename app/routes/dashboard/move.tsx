/**
 * Move this camp to another CampTool site (plans/camp-portability.md). Camp
 * admins only, and not while working as someone else.
 *
 * Starting a move freezes the camp (read-only) and shows a move code; the new
 * site's admin pastes it into its "Bring a camp here" page. When the new site
 * has the camp, it tells this one, which deletes the camp's data here and
 * forwards its old links (and vouches for its people's sign-ins) for a year.
 */
import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Code,
  Container,
  CopyButton,
  Group,
  List,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { data, Form, redirect, useNavigation } from "react-router";
import { LocalTime } from "~/components/LocalTime";
import { forgetMoves } from "~/lib/camp-move/forward.server";
import {
  CODE_DAYS,
  cancelMoveOut,
  completeMoveOut,
  moveCodeOf,
  openMoveFor,
  startMoveOut,
} from "~/lib/camp-move/move-out.server";
import { APEX } from "~/lib/env.server";
import { requireActiveCamp } from "~/lib/session.server";
import type { Route } from "./+types/move";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Move this camp · CampTool" }];
}

async function requireMover(request: Request) {
  const ctx = await requireActiveCamp(request, { allowWhileMoving: true });
  if (ctx.active.membership.role !== "admin" || ctx.impersonatedBy) {
    throw redirect("/");
  }
  return ctx;
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active } = await requireMover(request);
  const move = await openMoveFor(active.camp.id);
  return {
    codeDays: CODE_DAYS,
    campName: active.camp.name,
    move: move
      ? {
          code: await moveCodeOf(move, APEX.origin),
          expiresAt: move.codeExpiresAt.getTime(),
        }
      : null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { active, user } = await requireMover(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const move = await openMoveFor(active.camp.id);

  if (intent === "start") {
    if (form.get("understood") !== "on") {
      return data({ error: "Tick the box to confirm." }, { status: 400 });
    }
    if (!move) {
      await startMoveOut({
        campId: active.camp.id,
        campSlug: active.camp.slug,
        campName: active.camp.name,
        userId: user.id,
        origin: APEX.origin,
      });
    }
    return { ok: true };
  }
  if (!move)
    return data({ error: "There's no move going on." }, { status: 400 });
  if (intent === "cancel") {
    await cancelMoveOut(move.id);
    return { ok: true };
  }
  if (intent === "done") {
    // For a move by file, when the new site couldn't tell this one itself.
    let url: URL;
    try {
      url = new URL(String(form.get("targetCampUrl") ?? "").trim());
      const ok =
        url.protocol === "https:" ||
        (APEX.protocol === "http:" && url.protocol === "http:");
      if (!ok) throw new Error();
    } catch {
      return data(
        { error: "Give the camp's new address, like https://…" },
        { status: 400 },
      );
    }
    if (form.get("confirmDelete") !== "on") {
      return data({ error: "Tick the box to confirm." }, { status: 400 });
    }
    await completeMoveOut(move, { origin: url.origin, campUrl: url.href });
    forgetMoves();
    throw redirect("/");
  }
  return data({ error: "Unknown action." }, { status: 400 });
}

export default function MoveCamp({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { campName, move, codeDays } = loaderData;
  const busy = useNavigation().state !== "idle";
  const error = (actionData as { error?: string } | undefined)?.error;
  const [newUrl, setNewUrl] = useState("");

  return (
    <Container size="sm">
      <Stack gap="md">
        <div>
          <Title order={2}>Move camp</Title>
          <Text c="dimmed" size="sm">
            Transfer {campName} and all its data to another CampTool site.
          </Text>
        </div>
        {error && <Alert color="red">{error}</Alert>}

        {!move ? (
          <Paper withBorder p="lg" radius="md">
            <Form method="post">
              <input type="hidden" name="intent" value="start" />
              <Stack gap="sm">
                <Text size="sm" fw={500}>
                  Before you start:
                </Text>
                <List size="sm" spacing={4}>
                  <List.Item>
                    This camp becomes <b>read-only</b> until the move finishes
                    (you can cancel anytime before completion).
                  </List.Item>
                  <List.Item>
                    Paste the one-time <b>move code</b> (valid {codeDays} days)
                    on the destination site's Import a camp page.
                  </List.Item>
                  <List.Item>
                    Once imported, this copy is <b>deleted</b>, old links
                    forward for a year, and members sign in to create a passkey
                    on the new site. Passwords are not transferred.
                  </List.Item>
                </List>
                <Checkbox
                  name="understood"
                  label="I understand this camp will become read-only now and be deleted here once moved."
                />
                <Group justify="flex-end">
                  <Button type="submit" color="orange" loading={busy}>
                    Start move
                  </Button>
                </Group>
              </Stack>
            </Form>
          </Paper>
        ) : (
          <>
            <Paper withBorder p="lg" radius="md">
              <Stack gap="sm">
                <Text size="sm">
                  This camp is read-only. Paste this code at{" "}
                  <Code>/import-camp</Code> on the destination site (valid until{" "}
                  <LocalTime
                    iso={new Date(move.expiresAt).toISOString()}
                    format="YYYY-MM-DD h:mm A"
                  />
                  ).
                </Text>
                <Code block style={{ wordBreak: "break-all" }}>
                  {move.code}
                </Code>
                <Group justify="space-between">
                  <CopyButton value={move.code}>
                    {({ copied, copy }) => (
                      <Button size="xs" variant="light" onClick={copy}>
                        {copied ? "Copied" : "Copy code"}
                      </Button>
                    )}
                  </CopyButton>
                  <Anchor href="/move/bundle" size="sm" download>
                    Download bundle file
                  </Anchor>
                </Group>
                <Text size="xs" c="dimmed">
                  Keep this code private. Only download the encrypted bundle
                  file if the destination site can't reach this one.
                </Text>
              </Stack>
            </Paper>
            <Paper withBorder p="lg" radius="md">
              <Form method="post">
                <input type="hidden" name="intent" value="done" />
                <Stack gap="sm">
                  <Title order={4}>Finish manual file move</Title>
                  <Text size="sm" c="dimmed">
                    If you imported via file, enter the camp's new URL to delete
                    this copy and enable forwarding.
                  </Text>
                  <TextInput
                    name="targetCampUrl"
                    placeholder="https://…"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.currentTarget.value)}
                  />
                  <Checkbox
                    name="confirmDelete"
                    label="I've verified the camp on the new site. Delete it here."
                  />
                  <Group justify="flex-end">
                    <Button
                      type="submit"
                      color="red"
                      variant="light"
                      disabled={!newUrl}
                      loading={busy}
                    >
                      Finish move
                    </Button>
                  </Group>
                </Stack>
              </Form>
            </Paper>
            <Form method="post">
              <input type="hidden" name="intent" value="cancel" />
              <Group justify="flex-end">
                <Button type="submit" variant="subtle" loading={busy}>
                  Cancel move
                </Button>
              </Group>
            </Form>
          </>
        )}
      </Stack>
    </Container>
  );
}
