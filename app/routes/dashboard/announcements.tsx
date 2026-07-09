import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, eq } from "drizzle-orm";
import { useEffect, useState } from "react";
import { data, useFetcher } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { announcement, user } from "../../../db/schema";
import type { Route } from "./+types/announcements";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Announcements · CampTool" }];
}

type Row = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  authorName: string | null;
  createdAt: Date;
};

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "announcements");
  const rows = (await db
    .select({
      id: announcement.id,
      title: announcement.title,
      body: announcement.body,
      pinned: announcement.pinned,
      authorName: user.name,
      createdAt: announcement.createdAt,
    })
    .from(announcement)
    .leftJoin(user, eq(announcement.createdById, user.id))
    .where(eq(announcement.editionId, activeEdition.id))) satisfies Row[];

  rows.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return {
    isOfficer: hasAtLeast(active.membership.role, "officer"),
    locked: activeEdition.locked,
    year: activeEdition.year,
    announcements: rows,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const {
    user: actor,
    active,
    activeEdition,
  } = await requireActiveEdition(request);
  await requireFeature(active, "announcements");
  if (!hasAtLeast(active.membership.role, "officer")) {
    return data({ error: "Officers post announcements." }, { status: 403 });
  }
  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "deleteAnnouncement") {
    await db
      .delete(announcement)
      .where(
        and(
          eq(announcement.id, String(form.get("id"))),
          eq(announcement.editionId, editionId),
        ),
      );
    return data({ ok: true });
  }

  if (intent === "togglePin") {
    await db
      .update(announcement)
      .set({ pinned: form.get("pinned") === "true", updatedAt: new Date() })
      .where(
        and(
          eq(announcement.id, String(form.get("id"))),
          eq(announcement.editionId, editionId),
        ),
      );
    return data({ ok: true });
  }

  if (intent === "addAnnouncement") {
    const title = String(form.get("title") ?? "").trim();
    if (!title) return data({ error: "Add a title." }, { status: 400 });
    const body = String(form.get("body") ?? "").trim();
    await db.insert(announcement).values({
      id: crypto.randomUUID(),
      campId,
      editionId,
      title,
      body,
      pinned: form.get("pinned") === "true",
      createdById: actor.id,
    });
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Announcements({ loaderData }: Route.ComponentProps) {
  const { isOfficer, locked, year, announcements } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    } else if (fetcher.data?.ok) {
      setTitle("");
      setBody("");
      setPinned(false);
    }
  }, [fetcher.data]);

  function post() {
    if (!title.trim()) {
      notifications.show({ color: "red", message: "Add a title." });
      return;
    }
    fetcher.submit(
      {
        intent: "addAnnouncement",
        title,
        body,
        pinned: pinned ? "true" : "false",
      },
      { method: "post" },
    );
  }

  return (
    <Container size="sm">
      <Stack gap="lg">
        <div>
          <Title order={2}>Announcements</Title>
          <Text c="dimmed" size="sm">
            Camp news for {year}. Everyone in camp can read these; officers post
            them.
          </Text>
        </div>

        {isOfficer && !locked ? (
          <Card withBorder padding="md" radius="md">
            <Stack gap="sm">
              <TextInput
                size="sm"
                label="Title"
                placeholder="e.g. Work weekend June 14–15"
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
              />
              <Textarea
                size="sm"
                label="Details"
                placeholder="Optional details…"
                autosize
                minRows={2}
                value={body}
                onChange={(e) => setBody(e.currentTarget.value)}
              />
              <Group justify="space-between">
                <Checkbox
                  size="xs"
                  label="Pin to top"
                  checked={pinned}
                  onChange={(e) => setPinned(e.currentTarget.checked)}
                />
                <Button
                  size="xs"
                  onClick={post}
                  loading={fetcher.state !== "idle"}
                >
                  Post
                </Button>
              </Group>
            </Stack>
          </Card>
        ) : null}

        {announcements.length === 0 ? (
          <Paper withBorder p="md" radius="md">
            <Text size="sm" c="dimmed">
              No announcements yet for {year}.
            </Text>
          </Paper>
        ) : (
          <Stack gap="sm">
            {announcements.map((a) => (
              <Card key={a.id} withBorder padding="md" radius="md">
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <div style={{ minWidth: 0 }}>
                    <Group gap={6} wrap="nowrap">
                      {a.pinned ? (
                        <Badge size="xs" variant="light" color="yellow">
                          pinned
                        </Badge>
                      ) : null}
                      <Text fw={600}>{a.title}</Text>
                    </Group>
                    {a.body ? (
                      <Text size="sm" mt={4} style={{ whiteSpace: "pre-wrap" }}>
                        {a.body}
                      </Text>
                    ) : null}
                    <Text size="xs" c="dimmed" mt={6}>
                      {a.authorName ? `${a.authorName} · ` : ""}
                      {new Date(a.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </Text>
                  </div>
                  {isOfficer && !locked ? (
                    <Group gap={4} wrap="nowrap">
                      <Tooltip label={a.pinned ? "Unpin" : "Pin"}>
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          color={a.pinned ? "yellow" : "gray"}
                          aria-label="Pin"
                          onClick={() =>
                            fetcher.submit(
                              {
                                intent: "togglePin",
                                id: a.id,
                                pinned: a.pinned ? "false" : "true",
                              },
                              { method: "post" },
                            )
                          }
                        >
                          ★
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete">
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          color="red"
                          aria-label="Delete"
                          onClick={() =>
                            fetcher.submit(
                              { intent: "deleteAnnouncement", id: a.id },
                              { method: "post" },
                            )
                          }
                        >
                          ✕
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  ) : null}
                </Group>
              </Card>
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
