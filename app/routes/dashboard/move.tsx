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
          <Title order={2}>Move this camp</Title>
          <Text c="dimmed" size="sm">
            Take {campName} to another CampTool site: a site you run yourself,
            or a shared one. Everything comes along: members, maps, pictures,
            the lot.
          </Text>
        </div>
        {error && <Alert color="red">{error}</Alert>}

        {!move ? (
          <Paper withBorder p="lg" radius="md">
            <Form method="post">
              <input type="hidden" name="intent" value="start" />
              <Stack gap="sm">
                <Text size="sm">What happens:</Text>
                <List size="sm" spacing={4}>
                  <List.Item>
                    The camp becomes <b>read-only</b> here, so nothing written
                    during the move is lost. You can call it off any time before
                    it's done.
                  </List.Item>
                  <List.Item>
                    You get a <b>move code</b>. Paste it into the new site's
                    "Bring a camp here" page (signed in there as yourself). It
                    works once, for {codeDays} days.
                  </List.Item>
                  <List.Item>
                    When the new site has the camp, the camp is{" "}
                    <b>deleted here</b>. Old links forward to the new site for a
                    year, and everyone's sign-ins from here keep working there:
                    they'll be asked to make a passkey for the new site.
                  </List.Item>
                  <List.Item>Passwords never leave this site.</List.Item>
                </List>
                <Checkbox
                  name="understood"
                  label="I understand the camp will be read-only now and deleted here once it has moved."
                />
                <Group justify="flex-end">
                  <Button type="submit" color="orange" loading={busy}>
                    Start the move
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
                  The camp is read-only while it moves. Paste this code into the
                  new site's <b>Bring a camp here</b> page (
                  <Code>/import-camp</Code>). It works until{" "}
                  <LocalTime
                    iso={new Date(move.expiresAt).toISOString()}
                    format="YYYY-MM-DD h:mm A"
                  />
                  .
                </Text>
                <Code block style={{ wordBreak: "break-all" }}>
                  {move.code}
                </Code>
                <Group justify="space-between">
                  <CopyButton value={move.code}>
                    {({ copied, copy }) => (
                      <Button size="xs" variant="light" onClick={copy}>
                        {copied ? "Copied" : "Copy the code"}
                      </Button>
                    )}
                  </CopyButton>
                  <Anchor href="/move/bundle" size="sm" download>
                    Download the camp as a file
                  </Anchor>
                </Group>
                <Text size="xs" c="dimmed">
                  Keep the code private: it unlocks the camp's data. The file is
                  only needed when the new site can't reach this one; it's
                  encrypted with the code.
                </Text>
              </Stack>
            </Paper>
            <Paper withBorder p="lg" radius="md">
              <Form method="post">
                <input type="hidden" name="intent" value="done" />
                <Stack gap="sm">
                  <Title order={4}>Moved by file?</Title>
                  <Text size="sm" c="dimmed">
                    When the new site couldn't reach this one, finish the move
                    here: give the camp's new address. This deletes the camp
                    here and starts forwarding.
                  </Text>
                  <TextInput
                    name="targetCampUrl"
                    placeholder="https://…"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.currentTarget.value)}
                  />
                  <Checkbox
                    name="confirmDelete"
                    label="The camp is on the new site and looks right. Delete it here."
                  />
                  <Group justify="flex-end">
                    <Button
                      type="submit"
                      color="red"
                      variant="light"
                      disabled={!newUrl}
                      loading={busy}
                    >
                      Finish the move
                    </Button>
                  </Group>
                </Stack>
              </Form>
            </Paper>
            <Form method="post">
              <input type="hidden" name="intent" value="cancel" />
              <Group justify="flex-end">
                <Button type="submit" variant="subtle" loading={busy}>
                  Call off the move
                </Button>
              </Group>
            </Form>
          </>
        )}
      </Stack>
    </Container>
  );
}
