import {
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, eq } from "drizzle-orm";
import { useEffect, useMemo, useState } from "react";
import { Link, data, redirect, useFetcher } from "react-router";
import { WikiBody } from "~/components/WikiBody";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveCamp } from "~/lib/session.server";
import { KINDS } from "~/lib/structures";
import { isWikiSubjectType, parseWikiBody, wikiSubjectDef } from "~/lib/wiki";
import {
  addSubjectLink,
  backlinksTo,
  createPage,
  existingSlugs,
  getPageBySlug,
  pageHistory,
  removeSubjectLink,
  savePage,
  subjectsForPage,
} from "~/lib/wiki.server";
import { db } from "../../../db/client.server";
import { mapObject, wikiPage } from "../../../db/schema";
import type { Route } from "./+types/wiki.$slug";

export function meta({ data: d }: Route.MetaArgs) {
  return [{ title: `${d?.page?.title ?? "Wiki"} · CampTool` }];
}

/** Human label for a linked subject, resolved in its own namespace. */
function kindLabel(value: string): string {
  return KINDS.find((k) => k.value === value)?.label ?? value;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } = await requireActiveCamp(request);
  await requireFeature(active, "wiki");
  const campId = active.camp.id;
  const slug = params.slug;

  const page = await getPageBySlug(campId, slug);
  const canEdit = hasAtLeast(active.membership.role, "member");
  const isOfficer = hasAtLeast(active.membership.role, "officer");

  // A link to an unwritten page lands here rather than 404ing — that red-link
  // "start this page" moment is how a wiki grows.
  if (!page) {
    return redact(privacy, {
      page: null,
      slug,
      canEdit,
      isOfficer,
      knownSlugs: [] as string[],
      subjects: [] as Array<{
        id: string;
        type: string;
        label: string;
        href: string;
      }>,
      backlinks: [] as Array<{ id: string; slug: string; title: string }>,
      history: [] as Array<{
        id: string;
        editedAt: Date;
        summary: string | null;
      }>,
      structureOptions: [] as Array<{ value: string; label: string }>,
      objectOptions: [] as Array<{ value: string; label: string }>,
    });
  }

  const [links, knownSlugs, backlinks, history] = await Promise.all([
    subjectsForPage(campId, page.id),
    existingSlugs(campId),
    backlinksTo(campId, page.slug, page.id),
    pageHistory(campId, page.id),
  ]);

  // Resolve each tie's display name + where it points.
  const objectIds = links
    .filter((l) => l.subjectType === "map_object")
    .map((l) => l.subjectId);
  const objects = objectIds.length
    ? await db
        .select({
          id: mapObject.id,
          name: mapObject.name,
          kind: mapObject.kind,
        })
        .from(mapObject)
        .where(eq(mapObject.campId, campId))
    : [];
  const objectById = new Map(objects.map((o) => [o.id, o]));

  const subjects = links.map((l) => {
    const def = wikiSubjectDef(l.subjectType);
    let label = l.subjectId;
    if (l.subjectType === "structure_kind") label = kindLabel(l.subjectId);
    else if (l.subjectType === "map_object") {
      const o = objectById.get(l.subjectId);
      label = o ? (o.name ?? kindLabel(o.kind)) : "(removed object)";
    }
    return {
      id: l.id,
      type: def?.label ?? l.subjectType,
      label,
      href: def ? def.href(l.subjectId) : "/",
    };
  });

  // Options for "link this page to…": every structure kind, plus this year's
  // placed objects. Structure kinds come first — a kind-linked page survives
  // the yearly re-declare, a specific object does not.
  const linked = new Set(links.map((l) => `${l.subjectType}:${l.subjectId}`));
  const structureOptions = KINDS.filter(
    (k) => !linked.has(`structure_kind:${k.value}`),
  ).map((k) => ({ value: k.value, label: k.label }));

  const thisYear = activeEdition
    ? await db
        .select({
          id: mapObject.id,
          name: mapObject.name,
          kind: mapObject.kind,
        })
        .from(mapObject)
        .where(
          and(
            eq(mapObject.campId, campId),
            eq(mapObject.editionId, activeEdition.id),
          ),
        )
    : [];
  const objectOptions = thisYear
    .filter((o) => !linked.has(`map_object:${o.id}`))
    .map((o) => ({
      value: o.id,
      label: o.name ? `${o.name} (${kindLabel(o.kind)})` : kindLabel(o.kind),
    }));

  return redact(privacy, {
    page: {
      id: page.id,
      slug: page.slug,
      title: page.title,
      body: page.body,
      updatedAt: page.updatedAt,
    },
    slug,
    canEdit,
    isOfficer,
    knownSlugs: [...knownSlugs],
    subjects,
    backlinks,
    history: history.map((h) => ({
      id: h.id,
      editedAt: h.editedAt,
      summary: h.summary,
    })),
    structureOptions,
    objectOptions,
  });
}

export async function action({ params, request }: Route.ActionArgs) {
  const { user: actor, active } = await requireActiveCamp(request);
  await requireFeature(active, "wiki");
  const campId = active.camp.id;
  const role = active.membership.role;
  if (!hasAtLeast(role, "member")) {
    return data({ error: "Members write the wiki." }, { status: 403 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "createHere") {
    const created = await createPage({
      campId,
      title: String(form.get("title") ?? params.slug),
      userId: actor.id,
    });
    if (!created) return data({ error: "That page exists." }, { status: 400 });
    // Straight into the editor — creating a red-link page and then having to
    // find the Edit button is a pointless extra step.
    return redirect(`/wiki/${created.slug}/edit`);
  }

  const page = await getPageBySlug(campId, params.slug);
  if (!page) return data({ error: "No such page." }, { status: 404 });

  if (intent === "addLink") {
    const subjectType = String(form.get("subjectType"));
    const subjectId = String(form.get("subjectId") ?? "").trim();
    if (!isWikiSubjectType(subjectType) || !subjectId) {
      return data({ error: "Pick something to link." }, { status: 400 });
    }
    await addSubjectLink({
      campId,
      pageId: page.id,
      subjectType,
      subjectId,
      userId: actor.id,
    });
    return data({ ok: true });
  }

  if (intent === "removeLink") {
    await removeSubjectLink(campId, String(form.get("linkId")));
    return data({ ok: true });
  }

  if (intent === "restore") {
    if (!hasAtLeast(role, "officer")) {
      return data({ error: "Officers restore versions." }, { status: 403 });
    }
    const revisions = await pageHistory(campId, page.id);
    const rev = revisions.find((r) => r.id === String(form.get("revisionId")));
    if (!rev) return data({ error: "No such version." }, { status: 404 });
    await savePage({
      campId,
      page,
      title: rev.title,
      body: rev.body,
      summary: "Restored an earlier version",
      userId: actor.id,
    });
    return data({ ok: true });
  }

  if (intent === "delete") {
    if (!hasAtLeast(role, "officer")) {
      return data({ error: "Officers delete pages." }, { status: 403 });
    }
    await db
      .delete(wikiPage)
      .where(and(eq(wikiPage.id, page.id), eq(wikiPage.campId, campId)));
    return redirect("/wiki");
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function WikiPageView({ loaderData }: Route.ComponentProps) {
  const {
    page,
    slug,
    canEdit,
    isOfficer,
    knownSlugs,
    subjects,
    backlinks,
    history,
    structureOptions,
    objectOptions,
  } = loaderData;
  const fetcher = useFetcher<{ error?: string; ok?: boolean }>();
  const [linkValue, setLinkValue] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    } else if (fetcher.data?.ok) {
      setLinkValue(null);
      setConfirmDelete(false);
    }
  }, [fetcher.data]);

  const blocks = useMemo(() => (page ? parseWikiBody(page.body) : []), [page]);

  if (!page) {
    return (
      <Container size="sm">
        <Stack gap="md">
          <Title order={2}>{slug.replace(/-/g, " ")}</Title>
          <Paper withBorder p="md" radius="md">
            <Text size="sm" c="dimmed">
              Nobody has written this page yet.
            </Text>
            {canEdit ? (
              <Button
                mt="sm"
                size="xs"
                loading={fetcher.state !== "idle"}
                onClick={() =>
                  fetcher.submit(
                    {
                      intent: "createHere",
                      title: slug.replace(/-/g, " "),
                    },
                    { method: "post" },
                  )
                }
              >
                Create this page
              </Button>
            ) : null}
          </Paper>
          <Anchor component={Link} to="/wiki" size="sm">
            ← All pages
          </Anchor>
        </Stack>
      </Container>
    );
  }

  // Options are grouped so the map ties read as two different promises: a kind
  // is forever, a placed object is just this year.
  const linkOptions = [
    {
      group: "Structures (every year)",
      items: structureOptions.map((o) => ({
        value: `structure_kind:${o.value}`,
        label: o.label,
      })),
    },
    {
      group: "On the map this year",
      items: objectOptions.map((o) => ({
        value: `map_object:${o.value}`,
        label: o.label,
      })),
    },
  ].filter((g) => g.items.length > 0);

  return (
    <Container size="sm">
      <Stack gap="lg">
        <div>
          <Anchor component={Link} to="/wiki" size="sm">
            ← All pages
          </Anchor>
          <Group justify="space-between" align="flex-start" mt={4}>
            <Title order={2}>{page.title}</Title>
            {canEdit ? (
              <Button
                component={Link}
                to={`/wiki/${page.slug}/edit`}
                size="xs"
                variant="light"
              >
                Edit
              </Button>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed">
            Updated {new Date(page.updatedAt).toISOString().slice(0, 10)}
          </Text>
        </div>

        {subjects.length > 0 ? (
          <Group gap={6}>
            {subjects.map((s) => (
              <Badge
                key={s.id}
                variant="light"
                size="lg"
                rightSection={
                  canEdit ? (
                    <Anchor
                      component="button"
                      type="button"
                      c="dimmed"
                      aria-label={`Unlink ${s.label}`}
                      onClick={() =>
                        fetcher.submit(
                          { intent: "removeLink", linkId: s.id },
                          { method: "post" },
                        )
                      }
                    >
                      ✕
                    </Anchor>
                  ) : null
                }
              >
                <Anchor component={Link} to={s.href} inherit>
                  {s.type}: {s.label}
                </Anchor>
              </Badge>
            ))}
          </Group>
        ) : null}

        <Card withBorder padding="lg" radius="md">
          {page.body ? (
            <WikiBody blocks={blocks} knownSlugs={knownSlugs} />
          ) : (
            <Text size="sm" c="dimmed" fs="italic">
              This page is empty. {canEdit ? "Edit it to add something." : ""}
            </Text>
          )}
        </Card>

        {canEdit && linkOptions.length > 0 ? (
          <Card withBorder padding="md" radius="md">
            <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>
              Link this page to something
            </Text>
            <Text size="xs" c="dimmed" mb="xs">
              A structure gets its page shown on the map for every camper who
              places one — this year and every year after.
            </Text>
            <Group align="flex-end">
              <Select
                size="xs"
                placeholder="Pick a structure or a placed object"
                searchable
                data={linkOptions}
                value={linkValue}
                onChange={setLinkValue}
                style={{ flex: "1 1 240px" }}
              />
              <Button
                size="xs"
                disabled={!linkValue}
                loading={fetcher.state !== "idle"}
                onClick={() => {
                  if (!linkValue) return;
                  const [subjectType = "", ...rest] = linkValue.split(":");
                  fetcher.submit(
                    {
                      intent: "addLink",
                      subjectType,
                      subjectId: rest.join(":"),
                    },
                    { method: "post" },
                  );
                }}
              >
                Link
              </Button>
            </Group>
          </Card>
        ) : null}

        {backlinks.length > 0 ? (
          <div>
            <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>
              Pages that link here
            </Text>
            <Stack gap={2}>
              {backlinks.map((b) => (
                <Anchor
                  key={b.id}
                  component={Link}
                  to={`/wiki/${b.slug}`}
                  size="sm"
                >
                  {b.title}
                </Anchor>
              ))}
            </Stack>
          </div>
        ) : null}

        {history.length > 0 ? (
          <div>
            <Anchor
              component="button"
              type="button"
              size="sm"
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? "Hide" : "Show"} history ({history.length}{" "}
              {history.length === 1 ? "version" : "versions"})
            </Anchor>
            {showHistory ? (
              <Stack gap={4} mt="xs">
                {history.map((h) => (
                  <Paper key={h.id} withBorder p="xs" radius="sm">
                    <Group justify="space-between" wrap="nowrap">
                      <div style={{ minWidth: 0 }}>
                        <Text size="xs">
                          {new Date(h.editedAt)
                            .toISOString()
                            .slice(0, 16)
                            .replace("T", " ")}
                        </Text>
                        {h.summary ? (
                          <Text size="xs" c="dimmed">
                            {h.summary}
                          </Text>
                        ) : null}
                      </div>
                      {isOfficer ? (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          onClick={() =>
                            fetcher.submit(
                              { intent: "restore", revisionId: h.id },
                              { method: "post" },
                            )
                          }
                        >
                          Restore
                        </Button>
                      ) : null}
                    </Group>
                  </Paper>
                ))}
              </Stack>
            ) : null}
          </div>
        ) : null}

        {isOfficer ? (
          <>
            <Divider />
            <Group>
              <Button
                size="xs"
                color="red"
                variant="subtle"
                onClick={() => setConfirmDelete(true)}
              >
                Delete this page
              </Button>
            </Group>
            <Modal
              opened={confirmDelete}
              onClose={() => setConfirmDelete(false)}
              title={`Delete "${page.title}"?`}
            >
              <Stack gap="sm">
                <Text size="sm">
                  The page and its {history.length} saved{" "}
                  {history.length === 1 ? "version" : "versions"} go away for
                  good.
                </Text>
                <Group justify="flex-end">
                  <Button
                    variant="default"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Keep it
                  </Button>
                  <Button
                    color="red"
                    loading={fetcher.state !== "idle"}
                    onClick={() =>
                      fetcher.submit({ intent: "delete" }, { method: "post" })
                    }
                  >
                    Delete
                  </Button>
                </Group>
              </Stack>
            </Modal>
          </>
        ) : null}
      </Stack>
    </Container>
  );
}
