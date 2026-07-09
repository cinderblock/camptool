import {
  ActionIcon,
  Anchor,
  Autocomplete,
  Card,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, eq } from "drizzle-orm";
import { useEffect, useState } from "react";
import { data, useFetcher } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { requireActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { campDocument } from "../../../db/schema";
import type { Route } from "./+types/documents";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Documents · CampTool" }];
}

/** Make a user-typed link safe to use as an href: require http(s); default to
 * https:// when no scheme is given. Returns null if it doesn't look like a link. */
function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active } = await requireActiveCamp(request);
  await requireFeature(active, "documents");
  const docs = (
    await db
      .select({
        id: campDocument.id,
        title: campDocument.title,
        url: campDocument.url,
        description: campDocument.description,
        category: campDocument.category,
        sortOrder: campDocument.sortOrder,
      })
      .from(campDocument)
      .where(eq(campDocument.campId, active.camp.id))
  ).sort(
    (a, b) =>
      (a.category ?? "").localeCompare(b.category ?? "") ||
      a.sortOrder - b.sortOrder ||
      a.title.localeCompare(b.title),
  );

  const categories = [
    ...new Set(docs.map((d) => d.category).filter((c): c is string => !!c)),
  ].sort();

  return {
    isOfficer: hasAtLeast(active.membership.role, "officer"),
    documents: docs,
    categories,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { user: actor, active } = await requireActiveCamp(request);
  await requireFeature(active, "documents");
  if (!hasAtLeast(active.membership.role, "officer")) {
    return data({ error: "Officers manage documents." }, { status: 403 });
  }
  const campId = active.camp.id;
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "deleteDocument") {
    await db
      .delete(campDocument)
      .where(
        and(
          eq(campDocument.id, String(form.get("id"))),
          eq(campDocument.campId, campId),
        ),
      );
    return data({ ok: true });
  }

  if (intent === "addDocument") {
    const title = String(form.get("title") ?? "").trim();
    if (!title) return data({ error: "Add a title." }, { status: 400 });
    const url = normalizeUrl(String(form.get("url") ?? ""));
    if (!url) return data({ error: "Enter a valid link." }, { status: 400 });
    const str = (k: string) => {
      const s = String(form.get(k) ?? "").trim();
      return s === "" ? null : s;
    };
    await db.insert(campDocument).values({
      id: crypto.randomUUID(),
      campId,
      title,
      url,
      description: str("description"),
      category: str("category"),
      createdById: actor.id,
    });
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Documents({ loaderData }: Route.ComponentProps) {
  const { isOfficer, documents, categories } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    } else if (fetcher.data?.ok) {
      setTitle("");
      setUrl("");
      setDescription("");
    }
  }, [fetcher.data]);

  function add() {
    if (!title.trim() || !url.trim()) {
      notifications.show({ color: "red", message: "Title and link required." });
      return;
    }
    fetcher.submit(
      { intent: "addDocument", title, url, category, description },
      { method: "post" },
    );
  }

  // Group by category for display (uncategorized last under "Other").
  const groups = new Map<string, typeof documents>();
  for (const d of documents) {
    const key = d.category ?? "";
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }
  const groupKeys = [...groups.keys()].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });

  return (
    <Container size="sm">
      <Stack gap="lg">
        <div>
          <Title order={2}>Documents</Title>
          <Text c="dimmed" size="sm">
            Shared links the whole camp can open — packing lists, schedules, the
            handbook, your Drive folder. {isOfficer ? "Officers add them." : ""}
          </Text>
        </div>

        {isOfficer ? (
          <Card withBorder padding="md" radius="md">
            <Stack gap="sm">
              <Group align="flex-end" wrap="wrap">
                <TextInput
                  size="xs"
                  label="Title"
                  placeholder="e.g. Packing list"
                  value={title}
                  onChange={(e) => setTitle(e.currentTarget.value)}
                  style={{ flex: "1 1 200px" }}
                />
                <Autocomplete
                  size="xs"
                  label="Category"
                  placeholder="optional"
                  data={categories}
                  value={category}
                  onChange={setCategory}
                  w={150}
                />
              </Group>
              <TextInput
                size="xs"
                label="Link"
                placeholder="https://docs.google.com/…"
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
              />
              <Group justify="space-between" align="flex-end">
                <TextInput
                  size="xs"
                  label="Description (optional)"
                  value={description}
                  onChange={(e) => setDescription(e.currentTarget.value)}
                  style={{ flex: "1 1 260px" }}
                />
                <ActionIcon
                  size="lg"
                  variant="filled"
                  aria-label="Add document"
                  onClick={add}
                  loading={fetcher.state !== "idle"}
                >
                  +
                </ActionIcon>
              </Group>
            </Stack>
          </Card>
        ) : null}

        {documents.length === 0 ? (
          <Paper withBorder p="md" radius="md">
            <Text size="sm" c="dimmed">
              No documents shared yet.
            </Text>
          </Paper>
        ) : (
          <Stack gap="lg">
            {groupKeys.map((key) => (
              <div key={key || "other"}>
                <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>
                  {key || "Other"}
                </Text>
                <Stack gap={6}>
                  {(groups.get(key) ?? []).map((d) => (
                    <Paper key={d.id} withBorder p="sm" radius="md">
                      <Group justify="space-between" wrap="nowrap">
                        <div style={{ minWidth: 0 }}>
                          <Anchor
                            href={d.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            fw={500}
                            size="sm"
                          >
                            {d.title}
                          </Anchor>
                          {d.description ? (
                            <Text size="xs" c="dimmed">
                              {d.description}
                            </Text>
                          ) : null}
                        </div>
                        {isOfficer ? (
                          <Tooltip label="Remove">
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              color="red"
                              aria-label="Remove document"
                              onClick={() =>
                                fetcher.submit(
                                  { intent: "deleteDocument", id: d.id },
                                  { method: "post" },
                                )
                              }
                            >
                              ✕
                            </ActionIcon>
                          </Tooltip>
                        ) : null}
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              </div>
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
