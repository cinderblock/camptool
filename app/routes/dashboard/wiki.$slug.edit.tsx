import {
  Anchor,
  Button,
  Card,
  Container,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, data, redirect, useFetcher } from "react-router";
import { WikiBody } from "~/components/WikiBody";
import { featureVisibleTo } from "~/lib/features";
import { loadFeatureStates, requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveCamp } from "~/lib/session.server";
import { appLinkTargets, parseWikiBody, wikiSlug } from "~/lib/wiki";
import { existingSlugs, getPageBySlug, savePage } from "~/lib/wiki.server";
import type { Route } from "./+types/wiki.$slug.edit";

export function meta({ data: d }: Route.MetaArgs) {
  return [{ title: `Editing ${d?.title ?? "page"} · Wiki · CampTool` }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const { active, privacy } = await requireActiveCamp(request);
  await requireFeature(active, "wiki");
  if (!hasAtLeast(active.membership.role, "member")) throw redirect("/wiki");

  const page = await getPageBySlug(active.camp.id, params.slug);
  if (!page) throw redirect(`/wiki/${params.slug}`);

  // The link picker offers only what this camp can actually reach, so nobody
  // links a member to a feature that's turned off.
  const states = await loadFeatureStates(active.camp.id);
  const visible = [...states.entries()]
    .filter(([, state]) => featureVisibleTo(state, active.membership.role))
    .map(([key]) => key);

  const slugs = await existingSlugs(active.camp.id);
  return redact(privacy, {
    id: page.id,
    slug: page.slug,
    title: page.title,
    body: page.body,
    knownSlugs: [...slugs],
    linkTargets: appLinkTargets(visible),
  });
}

export async function action({ params, request }: Route.ActionArgs) {
  const { user: actor, active } = await requireActiveCamp(request);
  await requireFeature(active, "wiki");
  if (!hasAtLeast(active.membership.role, "member")) {
    return data({ error: "Members write the wiki." }, { status: 403 });
  }

  const campId = active.camp.id;
  const page = await getPageBySlug(campId, params.slug);
  if (!page) return data({ error: "No such page." }, { status: 404 });

  const form = await request.formData();
  const title = String(form.get("title") ?? "").trim();
  if (!title) return data({ error: "Keep a title." }, { status: 400 });

  await savePage({
    campId,
    page,
    title,
    // Body is stored verbatim (only newlines normalized) — it's the source text.
    body: String(form.get("body") ?? "").replace(/\r\n?/g, "\n"),
    summary: String(form.get("summary") ?? ""),
    userId: actor.id,
  });
  return redirect(`/wiki/${page.slug}`);
}

export default function WikiPageEdit({ loaderData }: Route.ComponentProps) {
  const {
    slug,
    title: initialTitle,
    body: initialBody,
    knownSlugs,
    linkTargets,
  } = loaderData;
  const fetcher = useFetcher<{ error?: string }>();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [summary, setSummary] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    }
  }, [fetcher.data]);

  const blocks = useMemo(() => parseWikiBody(body), [body]);

  /** Drop `[[/path|Label]]` in at the cursor — linking to another part of
   * CampTool shouldn't require remembering the URL. */
  function insertLink(path: string, label: string) {
    const el = bodyRef.current;
    const snippet = `[[${path}|${label}]]`;
    if (!el) {
      setBody((b) => (b ? `${b}\n${snippet}` : snippet));
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? start;
    // A selection becomes the link text; otherwise use the feature's own name.
    const selected = body.slice(start, end);
    const text = selected ? `[[${path}|${selected}]]` : snippet;
    const next = body.slice(0, start) + text + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + text.length;
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Anchor component={Link} to={`/wiki/${slug}`} size="sm">
            ← Back to the page
          </Anchor>
          <Title order={2} mt={4}>
            Editing
          </Title>
        </div>

        <TextInput
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        {wikiSlug(title) !== slug ? (
          <Text size="xs" c="dimmed">
            The address stays /wiki/{slug} — renaming the title doesn't break
            links other pages already made.
          </Text>
        ) : null}

        <div>
          <Group justify="space-between" align="flex-end" mb={4}>
            <Text size="sm" fw={500}>
              Body
            </Text>
            <Select
              size="xs"
              placeholder="Insert a link to…"
              searchable
              w={220}
              value={null}
              data={linkTargets.map((t) => ({
                value: t.path,
                label: t.label,
              }))}
              onChange={(value) => {
                const target = linkTargets.find((t) => t.path === value);
                if (target) insertLink(target.path, target.label);
              }}
            />
          </Group>
          <Textarea
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            autosize
            minRows={14}
            maxRows={40}
            styles={{ input: { fontFamily: "monospace", fontSize: "0.85rem" } }}
          />
          <Text size="xs" c="dimmed" mt={4}>
            <strong>#</strong> heading · <strong>-</strong> bullet ·{" "}
            <strong>**bold**</strong> · <strong>`code`</strong> ·{" "}
            <strong>[[Another page]]</strong> to link a wiki page ·{" "}
            <strong>[[/map|the map]]</strong> to link anywhere in CampTool.
          </Text>
        </div>

        <TextInput
          label="What changed? (optional)"
          placeholder="e.g. added the guy-line spacing"
          value={summary}
          onChange={(e) => setSummary(e.currentTarget.value)}
        />

        <Group justify="flex-end">
          <Button component={Link} to={`/wiki/${slug}`} variant="default">
            Cancel
          </Button>
          <Button
            loading={fetcher.state !== "idle"}
            onClick={() =>
              fetcher.submit({ title, body, summary }, { method: "post" })
            }
          >
            Save
          </Button>
        </Group>

        <div>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>
            Preview
          </Text>
          <Card withBorder padding="lg" radius="md">
            {body.trim() ? (
              <WikiBody blocks={blocks} knownSlugs={knownSlugs} />
            ) : (
              <Text size="sm" c="dimmed" fs="italic">
                Nothing yet.
              </Text>
            )}
          </Card>
        </div>
      </Stack>
    </Container>
  );
}
