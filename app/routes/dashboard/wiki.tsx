import {
  Alert,
  Anchor,
  Button,
  Card,
  Container,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import { Link, data, useFetcher } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveCamp } from "~/lib/session.server";
import { KINDS } from "~/lib/structures";
import { isWikiSubjectType, wikiExcerpt, wikiSlug } from "~/lib/wiki";
import { addSubjectLink, createPage, listPages } from "~/lib/wiki.server";
import type { Route } from "./+types/wiki";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Wiki · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, privacy } = await requireActiveCamp(request);
  await requireFeature(active, "wiki");

  // "Start a wiki page for the Sierpinski pyramid" on the map arrives here as
  // ?subject=structure_kind:sierpinski-pyramid — prefill and pre-link it.
  const raw = new URL(request.url).searchParams.get("subject");
  let pendingSubject: { type: string; id: string; label: string } | null = null;
  if (raw) {
    const [type = "", ...rest] = raw.split(":");
    const id = rest.join(":");
    if (isWikiSubjectType(type) && id) {
      const label =
        type === "structure_kind"
          ? (KINDS.find((k) => k.value === id)?.label ?? id)
          : id;
      pendingSubject = { type, id, label };
    }
  }

  const pages = await listPages(active.camp.id);
  return redact(privacy, {
    pendingSubject,
    canEdit: hasAtLeast(active.membership.role, "member"),
    pages: pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      excerpt: wikiExcerpt(p.body),
      updatedAt: p.updatedAt,
    })),
  });
}

export async function action({ request }: Route.ActionArgs) {
  const { user: actor, active } = await requireActiveCamp(request);
  await requireFeature(active, "wiki");
  // The whole point of the feature: any member may write. Recruits read only.
  if (!hasAtLeast(active.membership.role, "member")) {
    return data({ error: "Members write the wiki." }, { status: 403 });
  }

  const form = await request.formData();
  if (String(form.get("intent")) !== "create") {
    return data({ error: "Unknown action." }, { status: 400 });
  }

  const title = String(form.get("title") ?? "").trim();
  if (!title) return data({ error: "Give the page a title." }, { status: 400 });
  if (!wikiSlug(title)) {
    return data(
      { error: "That title needs at least one letter or number." },
      { status: 400 },
    );
  }

  const created = await createPage({
    campId: active.camp.id,
    title,
    userId: actor.id,
  });
  if (!created) {
    return data({ error: `"${title}" already exists.` }, { status: 400 });
  }

  // Carry the map's hand-off through: the new page comes out already tied to
  // the structure it was started from.
  const subjectType = String(form.get("subjectType") ?? "");
  const subjectId = String(form.get("subjectId") ?? "").trim();
  if (isWikiSubjectType(subjectType) && subjectId) {
    await addSubjectLink({
      campId: active.camp.id,
      pageId: created.id,
      subjectType,
      subjectId,
      userId: actor.id,
    });
  }
  return data({ ok: true, slug: created.slug });
}

export default function WikiIndex({ loaderData }: Route.ComponentProps) {
  const { pages, canEdit, pendingSubject } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string; slug?: string }>();
  const [createOpen, setCreateOpen] = useState(!!pendingSubject && canEdit);
  const [title, setTitle] = useState(pendingSubject?.label ?? "");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    } else if (fetcher.data?.ok) {
      setCreateOpen(false);
      setTitle("");
    }
  }, [fetcher.data]);

  // Client-side filter: a camp's wiki is dozens of pages, not thousands.
  const q = query.trim().toLowerCase();
  const shown = q
    ? pages.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.excerpt.toLowerCase().includes(q),
      )
    : pages;

  return (
    <Container size="sm">
      <Stack gap="lg">
        <div>
          <Group justify="space-between" align="flex-start">
            <Title order={2}>Wiki</Title>
            {canEdit ? (
              <Button size="xs" onClick={() => setCreateOpen(true)}>
                New page
              </Button>
            ) : null}
          </Group>
          <Text c="dimmed" size="sm">
            Camp knowledge that outlives any one year — how things work, where
            things live, what we learned.{" "}
            {canEdit
              ? "Any member can edit any page; every save keeps the previous version."
              : "Members keep it up to date."}
          </Text>
        </div>

        {pages.length > 3 ? (
          <TextInput
            size="xs"
            placeholder="Search pages"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        ) : null}

        <Modal
          opened={createOpen}
          onClose={() => setCreateOpen(false)}
          title="New wiki page"
        >
          <Stack gap="sm">
            <TextInput
              label="Page title"
              placeholder="e.g. Raising the Sierpinski pyramid"
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
              data-autofocus
            />
            {title.trim() ? (
              <Text size="xs" c="dimmed">
                Address: /wiki/{wikiSlug(title) || "…"}
              </Text>
            ) : null}
            {pendingSubject ? (
              <Text size="xs" c="dimmed">
                Will be linked to {pendingSubject.label} — it'll show on the map
                for every one of them, every year.
              </Text>
            ) : null}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                loading={fetcher.state !== "idle"}
                onClick={() =>
                  fetcher.submit(
                    {
                      intent: "create",
                      title,
                      subjectType: pendingSubject?.type ?? "",
                      subjectId: pendingSubject?.id ?? "",
                    },
                    { method: "post" },
                  )
                }
              >
                Create
              </Button>
            </Group>
          </Stack>
        </Modal>

        {fetcher.data?.ok && fetcher.data.slug ? (
          <Alert color="green" title="Page created">
            <Anchor component={Link} to={`/wiki/${fetcher.data.slug}/edit`}>
              Start writing it →
            </Anchor>
          </Alert>
        ) : null}

        {pages.length === 0 ? (
          <Card withBorder padding="md" radius="md">
            <Text size="sm" c="dimmed">
              No pages yet.{" "}
              {canEdit
                ? "Start one for anything worth writing down — a structure, a system, a checklist."
                : ""}
            </Text>
          </Card>
        ) : shown.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing matches "{query}".
          </Text>
        ) : (
          <Stack gap={6}>
            {shown.map((p) => (
              <Card key={p.id} withBorder padding="sm" radius="md">
                <Anchor component={Link} to={`/wiki/${p.slug}`} fw={500}>
                  {p.title}
                </Anchor>
                {p.excerpt ? (
                  <Text size="xs" c="dimmed" lineClamp={2}>
                    {p.excerpt}
                  </Text>
                ) : (
                  <Text size="xs" c="dimmed" fs="italic">
                    Empty page
                  </Text>
                )}
                <Text size="xs" c="dimmed" mt={4}>
                  Updated {new Date(p.updatedAt).toISOString().slice(0, 10)}
                </Text>
              </Card>
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
