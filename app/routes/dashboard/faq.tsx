/**
 * The FAQ — a searchable Q&A list (see plans/camp-faq.md).
 *
 * Three audiences on one page:
 *  - everyone reads the published list, and can ask a question that isn't on it
 *  - the asker sees their own pending question while it waits
 *  - officers get the pending queue, the editor, and category management
 *
 * Answers are written in the wiki body format, so an answer can point deep into
 * CampTool — `[[/tickets|request one here]]` — and straight at a wiki page.
 */
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Collapse,
  Container,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useMemo, useState } from "react";
import { Link, data, useFetcher } from "react-router";
import { MarkupTextarea } from "~/components/MarkupTextarea";
import { WikiBody } from "~/components/WikiBody";
import {
  type FaqStatus,
  faqMatches,
  groupFaqEntries,
  isFaqStatus,
} from "~/lib/faq";
import {
  createCategory,
  createEntry,
  deleteCategory,
  deleteEntry,
  getEntryById,
  listCategories,
  listEntries,
  moveCategory,
  moveEntry,
  renameCategory,
  setEntryStatus,
  updateEntry,
} from "~/lib/faq.server";
import { featureVisibleTo } from "~/lib/features";
import { loadFeatureStates, requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveCamp } from "~/lib/session.server";
import { type LinkTarget, appLinkTargets, parseWikiBody } from "~/lib/wiki";
import { existingSlugs, listPages } from "~/lib/wiki.server";
import type { Route } from "./+types/faq";

export function meta(_: Route.MetaArgs) {
  return [{ title: "FAQ · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user: viewer, active, privacy } = await requireActiveCamp(request);
  await requireFeature(active, "faq");
  const isOfficer = hasAtLeast(active.membership.role, "officer");

  const states = await loadFeatureStates(active.camp.id);
  const visible = [...states.entries()]
    .filter(([, state]) => featureVisibleTo(state, active.membership.role))
    .map(([key]) => key);
  const wikiEnabled = visible.includes("wiki");

  const [categories, rows, pages, slugs] = await Promise.all([
    listCategories(active.camp.id),
    // Officers see everything so they can work the queue and un-archive;
    // everyone else sees what's published plus their own question in flight.
    listEntries(
      active.camp.id,
      isOfficer
        ? ["published", "pending", "archived"]
        : ["published", "pending"],
    ),
    wikiEnabled ? listPages(active.camp.id) : Promise.resolve([]),
    wikiEnabled
      ? existingSlugs(active.camp.id)
      : Promise.resolve(new Set<string>()),
  ]);

  const entries = rows
    .filter(
      (e) =>
        e.status === "published" ||
        isOfficer ||
        (e.status === "pending" && e.askedById === viewer.id),
    )
    .map((e) => ({
      id: e.id,
      slug: e.slug,
      question: e.question,
      answer: e.answer,
      status: e.status,
      categoryId: e.categoryId,
      position: e.position,
      mine: e.askedById === viewer.id,
      askedAt: e.askedAt,
    }));

  // The picker that makes "link deeply, especially wiki" a click. FAQ answers
  // aren't offered here — an answer that links to another answer is a smell;
  // merge them instead.
  const linkTargets: LinkTarget[] = [
    ...appLinkTargets(visible).map((t) => ({
      group: "CampTool",
      path: t.path,
      label: t.label,
      kind: "route" as const,
    })),
    ...pages.map((p) => ({
      group: "Wiki pages",
      path: p.title,
      label: p.title,
      kind: "wiki" as const,
    })),
  ];

  return redact(privacy, {
    isOfficer,
    wikiEnabled,
    knownSlugs: [...slugs],
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      position: c.position,
    })),
    entries,
    linkTargets,
    openSlug: new URL(request.url).searchParams.get("open"),
  });
}

export async function action({ request }: Route.ActionArgs) {
  const { user: actor, active } = await requireActiveCamp(request);
  await requireFeature(active, "faq");
  const campId = active.camp.id;
  const isOfficer = hasAtLeast(active.membership.role, "officer");

  const form = await request.formData();
  const intent = String(form.get("intent"));
  const str = (k: string) => String(form.get(k) ?? "").trim();

  // ---- open to everyone who can see the FAQ (recruits included: an applicant
  // is exactly the person with questions, and asking isn't publishing).
  if (intent === "ask") {
    const question = str("question");
    if (!question) {
      return data({ error: "Type your question first." }, { status: 400 });
    }
    const created = await createEntry({
      campId,
      question,
      status: "pending",
      userId: actor.id,
      asked: true,
    });
    if (!created)
      return data({ error: "Couldn't post that." }, { status: 400 });
    return data({ ok: true, asked: true });
  }

  if (intent === "withdraw") {
    const entry = await getEntryById(campId, str("id"));
    // Only your own, and only while it's still unanswered.
    if (!entry || entry.askedById !== actor.id || entry.status !== "pending") {
      return data({ error: "That question isn't yours." }, { status: 403 });
    }
    await deleteEntry(campId, entry.id);
    return data({ ok: true });
  }

  // ---- officers from here down
  if (!isOfficer) {
    return data({ error: "Officers manage the FAQ." }, { status: 403 });
  }

  switch (intent) {
    case "create": {
      const question = str("question");
      if (!question) return data({ error: "Add a question." }, { status: 400 });
      const created = await createEntry({
        campId,
        question,
        answer: str("answer"),
        categoryId: str("categoryId") || null,
        status: statusFrom(form.get("status"), "published"),
        userId: actor.id,
      });
      if (!created) {
        return data({ error: "Couldn't create that." }, { status: 400 });
      }
      return data({ ok: true, slug: created.slug });
    }
    case "update": {
      const entry = await getEntryById(campId, str("id"));
      if (!entry) return data({ error: "No such question." }, { status: 404 });
      const question = str("question");
      if (!question)
        return data({ error: "Keep a question." }, { status: 400 });
      await updateEntry({
        campId,
        entry,
        question,
        answer: String(form.get("answer") ?? "").replace(/\r\n?/g, "\n"),
        categoryId: str("categoryId") || null,
        status: statusFrom(form.get("status"), entry.status as FaqStatus),
        userId: actor.id,
      });
      return data({ ok: true });
    }
    case "status": {
      const status = statusFrom(form.get("status"), null);
      if (!status) return data({ error: "Unknown status." }, { status: 400 });
      await setEntryStatus(campId, str("id"), status, actor.id);
      return data({ ok: true });
    }
    case "delete":
      await deleteEntry(campId, str("id"));
      return data({ ok: true });
    case "move":
      await moveEntry(campId, str("id"), str("dir") === "up" ? "up" : "down");
      return data({ ok: true });
    case "addCategory": {
      const made = await createCategory({
        campId,
        name: str("name"),
        userId: actor.id,
      });
      if (!made) {
        return data(
          { error: "That category already exists." },
          { status: 400 },
        );
      }
      return data({ ok: true });
    }
    case "renameCategory":
      // Only the label moves — the slug stays put so nothing that pointed at
      // this category goes stale over a wording change.
      await renameCategory(campId, str("id"), str("name"));
      return data({ ok: true });
    case "deleteCategory":
      // Entries filed under it fall back to General — the FK is SET NULL.
      await deleteCategory(campId, str("id"));
      return data({ ok: true });
    case "moveCategory":
      await moveCategory(
        campId,
        str("id"),
        str("dir") === "up" ? "up" : "down",
      );
      return data({ ok: true });
    default:
      return data({ error: "Unknown action." }, { status: 400 });
  }
}

function statusFrom<T>(
  raw: FormDataEntryValue | null,
  fallback: T,
): FaqStatus | T {
  const v = String(raw ?? "");
  return isFaqStatus(v) ? v : fallback;
}

type Draft = {
  id: string | null;
  question: string;
  answer: string;
  categoryId: string | null;
  status: FaqStatus;
};

const BLANK: Draft = {
  id: null,
  question: "",
  answer: "",
  categoryId: null,
  status: "published",
};

export default function Faq({ loaderData }: Route.ComponentProps) {
  const {
    isOfficer,
    wikiEnabled,
    knownSlugs,
    categories,
    entries,
    linkTargets,
    openSlug,
  } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(entries.filter((e) => e.slug === openSlug).map((e) => e.id)),
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [askText, setAskText] = useState("");
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  /** In-flight category renames, keyed by id — the loader's name is the truth
   * until one is committed on blur. */
  const [renames, setRenames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    } else if (fetcher.data?.ok) {
      setDraft(null);
      setAskText("");
      setNewCategory("");
    }
  }, [fetcher.data]);

  const submit = (values: Record<string, string>) =>
    fetcher.submit(values, { method: "post" });

  const published = entries.filter((e) => e.status === "published");
  const pending = entries.filter((e) => e.status === "pending");
  const archived = entries.filter((e) => e.status === "archived");
  const myPending = pending.filter((e) => e.mine);

  const q = query.trim();
  const matched = useMemo(
    () => (q ? published.filter((e) => faqMatches(e, q)) : published),
    [published, q],
  );
  const groups = useMemo(
    () => groupFaqEntries(matched, categories),
    [matched, categories],
  );

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** While searching, every hit is expanded — scanning a filtered list means
   * reading the answers, not clicking each one open. */
  const isOpen = (id: string) => (q ? true : open.has(id));

  const categoryData = categories.map((c) => ({ value: c.id, label: c.name }));

  function Answer({ body }: { body: string }) {
    return body.trim() ? (
      <WikiBody
        blocks={parseWikiBody(body)}
        knownSlugs={knownSlugs}
        wikiEnabled={wikiEnabled}
      />
    ) : (
      <Text size="sm" c="dimmed" fs="italic">
        Not answered yet.
      </Text>
    );
  }

  return (
    <Container size="sm">
      <Stack gap="lg">
        <div>
          <Group justify="space-between" align="flex-start">
            <Title order={2}>FAQ</Title>
            {isOfficer ? (
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => setCategoriesOpen(true)}
                >
                  Categories
                </Button>
                <Button size="xs" onClick={() => setDraft(BLANK)}>
                  New answer
                </Button>
              </Group>
            ) : null}
          </Group>
          <Text c="dimmed" size="sm">
            The questions people actually ask, answered once.{" "}
            {isOfficer
              ? "Officers write the answers; anyone can add a question to the queue."
              : "Can't find yours? Ask it at the bottom — an officer will answer."}
          </Text>
        </div>

        {published.length > 3 ? (
          <TextInput
            placeholder="Search questions and answers"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        ) : null}

        {/* The asker's own question, while it waits. */}
        {!isOfficer && myPending.length > 0 ? (
          <Alert color="blue" title="Waiting on an officer">
            <Stack gap={6}>
              {myPending.map((e) => (
                <Group key={e.id} justify="space-between" wrap="nowrap">
                  <Text size="sm">{e.question}</Text>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    onClick={() => submit({ intent: "withdraw", id: e.id })}
                  >
                    Withdraw
                  </Button>
                </Group>
              ))}
            </Stack>
          </Alert>
        ) : null}

        {/* The officer queue. */}
        {isOfficer && pending.length > 0 ? (
          <Card withBorder padding="md" radius="md">
            <Group justify="space-between" mb="xs">
              <Text fw={600} size="sm">
                Waiting on an answer
              </Text>
              <Badge color="orange">{pending.length}</Badge>
            </Group>
            <Stack gap={6}>
              {pending.map((e) => (
                <Paper key={e.id} withBorder p="sm" radius="md">
                  <Group
                    justify="space-between"
                    wrap="nowrap"
                    align="flex-start"
                  >
                    <div style={{ minWidth: 0 }}>
                      <Text size="sm">{e.question}</Text>
                      {e.askedAt ? (
                        <Text size="xs" c="dimmed">
                          Asked {new Date(e.askedAt).toISOString().slice(0, 10)}
                        </Text>
                      ) : null}
                    </div>
                    <Group gap={6} wrap="nowrap">
                      <Button
                        size="compact-xs"
                        onClick={() =>
                          setDraft({
                            id: e.id,
                            question: e.question,
                            answer: e.answer,
                            categoryId: e.categoryId,
                            status: "published",
                          })
                        }
                      >
                        Answer
                      </Button>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        onClick={() =>
                          submit({
                            intent: "status",
                            id: e.id,
                            status: "archived",
                          })
                        }
                      >
                        Archive
                      </Button>
                    </Group>
                  </Group>
                </Paper>
              ))}
            </Stack>
          </Card>
        ) : null}

        {published.length === 0 ? (
          <Paper withBorder p="md" radius="md">
            <Text size="sm" c="dimmed">
              Nothing answered yet.{" "}
              {isOfficer
                ? "Write the first answer, or wait for someone to ask."
                : ""}
            </Text>
          </Paper>
        ) : groups.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing matches "{q}". Ask it below and an officer will answer.
          </Text>
        ) : (
          <Stack gap="lg">
            {groups.map((group) => (
              <div key={group.id ?? "general"}>
                <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>
                  {group.name}
                </Text>
                <Stack gap={6}>
                  {group.entries.map((e, i) => (
                    <Paper key={e.id} withBorder p="sm" radius="md">
                      <Group justify="space-between" wrap="nowrap" gap="xs">
                        <UnstyledButton
                          onClick={() => toggle(e.id)}
                          style={{ flex: 1, minWidth: 0, textAlign: "left" }}
                        >
                          <Group gap={6} wrap="nowrap" align="flex-start">
                            <Text size="sm" c="dimmed" w={12}>
                              {isOpen(e.id) ? "▾" : "▸"}
                            </Text>
                            <Text size="sm" fw={500}>
                              {e.question}
                            </Text>
                          </Group>
                        </UnstyledButton>
                        {isOfficer ? (
                          <Group gap={2} wrap="nowrap">
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              aria-label="Move up"
                              disabled={i === 0}
                              onClick={() =>
                                submit({ intent: "move", id: e.id, dir: "up" })
                              }
                            >
                              ↑
                            </ActionIcon>
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              aria-label="Move down"
                              disabled={i === group.entries.length - 1}
                              onClick={() =>
                                submit({
                                  intent: "move",
                                  id: e.id,
                                  dir: "down",
                                })
                              }
                            >
                              ↓
                            </ActionIcon>
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              onClick={() =>
                                setDraft({
                                  id: e.id,
                                  question: e.question,
                                  answer: e.answer,
                                  categoryId: e.categoryId,
                                  status: "published",
                                })
                              }
                            >
                              Edit
                            </Button>
                          </Group>
                        ) : null}
                      </Group>
                      <Collapse in={isOpen(e.id)}>
                        <div style={{ paddingTop: 8, paddingLeft: 18 }}>
                          <Answer body={e.answer} />
                          <Anchor
                            component={Link}
                            to={`/faq/${e.slug}`}
                            size="xs"
                            c="dimmed"
                          >
                            Link to this answer →
                          </Anchor>
                        </div>
                      </Collapse>
                    </Paper>
                  ))}
                </Stack>
              </div>
            ))}
          </Stack>
        )}

        {/* Anyone who can read the FAQ can add to it. */}
        <Card withBorder padding="md" radius="md">
          <Stack gap="xs">
            <Text fw={600} size="sm">
              Don't see your question?
            </Text>
            <Textarea
              placeholder="e.g. Where do I park if I arrive after dark?"
              value={askText}
              onChange={(e) => setAskText(e.currentTarget.value)}
              autosize
              minRows={2}
            />
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                It goes to the officers, and the answer lands here for everyone.
              </Text>
              <Button
                size="xs"
                disabled={!askText.trim()}
                loading={fetcher.state !== "idle"}
                onClick={() => submit({ intent: "ask", question: askText })}
              >
                Ask
              </Button>
            </Group>
          </Stack>
        </Card>

        {isOfficer && archived.length > 0 ? (
          <div>
            <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>
              Archived · officers only
            </Text>
            <Stack gap={6}>
              {archived.map((e) => (
                <Paper key={e.id} withBorder p="sm" radius="md">
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">
                      {e.question}
                    </Text>
                    <Group gap={6} wrap="nowrap">
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        onClick={() =>
                          setDraft({
                            id: e.id,
                            question: e.question,
                            answer: e.answer,
                            categoryId: e.categoryId,
                            status: "published",
                          })
                        }
                      >
                        Restore
                      </Button>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        onClick={() => submit({ intent: "delete", id: e.id })}
                      >
                        Delete
                      </Button>
                    </Group>
                  </Group>
                </Paper>
              ))}
            </Stack>
          </div>
        ) : null}

        <Modal
          opened={!!draft}
          onClose={() => setDraft(null)}
          title={draft?.id ? "Edit answer" : "New answer"}
          size="lg"
        >
          {draft ? (
            <Stack gap="sm">
              <TextInput
                label="Question"
                placeholder="e.g. How do I get a ticket through the camp?"
                value={draft.question}
                onChange={(e) =>
                  setDraft({ ...draft, question: e.currentTarget.value })
                }
                data-autofocus
              />
              <Group grow align="flex-end">
                <Select
                  label="Category"
                  placeholder="General"
                  clearable
                  data={categoryData}
                  value={draft.categoryId}
                  onChange={(v) => setDraft({ ...draft, categoryId: v })}
                />
                <Select
                  label="Status"
                  data={[
                    { value: "published", label: "Published" },
                    { value: "pending", label: "Still pending" },
                    { value: "archived", label: "Archived" },
                  ]}
                  value={draft.status}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      status: isFaqStatus(v ?? "")
                        ? (v as FaqStatus)
                        : draft.status,
                    })
                  }
                />
              </Group>
              <MarkupTextarea
                label="Answer"
                value={draft.answer}
                onChange={(answer) => setDraft({ ...draft, answer })}
                targets={linkTargets}
                minRows={6}
                maxRows={24}
                placeholder="Answer it once, properly — and link to the page that has the detail."
              />
              {draft.answer.trim() ? (
                <div>
                  <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>
                    Preview
                  </Text>
                  <Card withBorder padding="md" radius="md">
                    <Answer body={draft.answer} />
                  </Card>
                </div>
              ) : null}
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button
                  loading={fetcher.state !== "idle"}
                  onClick={() =>
                    submit({
                      intent: draft.id ? "update" : "create",
                      id: draft.id ?? "",
                      question: draft.question,
                      answer: draft.answer,
                      categoryId: draft.categoryId ?? "",
                      status: draft.status,
                    })
                  }
                >
                  Save
                </Button>
              </Group>
            </Stack>
          ) : null}
        </Modal>

        <Modal
          opened={categoriesOpen}
          onClose={() => setCategoriesOpen(false)}
          title="FAQ categories"
        >
          <Stack gap="sm">
            <Text size="xs" c="dimmed">
              Answers with no category are listed under "General" at the end.
              Deleting a category keeps its answers — they fall back to General.
            </Text>
            {categories.map((c, i) => (
              <Group key={c.id} justify="space-between" wrap="nowrap">
                {/* Renaming in place: the name is a label, and changing it is
                    safe — the category's slug never moves. */}
                <TextInput
                  size="xs"
                  aria-label={`Rename ${c.name}`}
                  style={{ flex: 1 }}
                  value={renames[c.id] ?? c.name}
                  onChange={(e) =>
                    setRenames({ ...renames, [c.id]: e.currentTarget.value })
                  }
                  onBlur={(e) => {
                    const name = e.currentTarget.value.trim();
                    if (name && name !== c.name) {
                      submit({ intent: "renameCategory", id: c.id, name });
                    }
                  }}
                />
                <Group gap={2} wrap="nowrap">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    aria-label={`Move ${c.name} up`}
                    disabled={i === 0}
                    onClick={() =>
                      submit({ intent: "moveCategory", id: c.id, dir: "up" })
                    }
                  >
                    ↑
                  </ActionIcon>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    aria-label={`Move ${c.name} down`}
                    disabled={i === categories.length - 1}
                    onClick={() =>
                      submit({ intent: "moveCategory", id: c.id, dir: "down" })
                    }
                  >
                    ↓
                  </ActionIcon>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="red"
                    aria-label={`Delete ${c.name}`}
                    onClick={() =>
                      submit({ intent: "deleteCategory", id: c.id })
                    }
                  >
                    ✕
                  </ActionIcon>
                </Group>
              </Group>
            ))}
            <Group align="flex-end">
              <TextInput
                size="xs"
                label="Add a category"
                placeholder="e.g. Getting there"
                value={newCategory}
                onChange={(e) => setNewCategory(e.currentTarget.value)}
                style={{ flex: 1 }}
              />
              <Button
                size="xs"
                disabled={!newCategory.trim()}
                onClick={() =>
                  submit({ intent: "addCategory", name: newCategory })
                }
              >
                Add
              </Button>
            </Group>
          </Stack>
        </Modal>
      </Stack>
    </Container>
  );
}
