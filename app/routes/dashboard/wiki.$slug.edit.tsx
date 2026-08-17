import {
  Anchor,
  Button,
  Card,
  Container,
  Group,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useMemo, useState } from "react";
import { Link, data, redirect, useFetcher } from "react-router";
import { MarkupTextarea } from "~/components/MarkupTextarea";
import { WikiBody } from "~/components/WikiBody";
import { faqLinkTargets } from "~/lib/faq.server";
import { featureVisibleTo } from "~/lib/features";
import { loadFeatureStates, requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveCamp } from "~/lib/session.server";
import {
  type LinkTarget,
  appLinkTargets,
  parseWikiBody,
  wikiSlug,
} from "~/lib/wiki";
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
  // Two groups in the picker: everywhere in CampTool this camp can reach, and
  // the camp's own published FAQ answers. Wiki pages aren't offered — inside
  // the wiki, `[[Another page]]` is already the natural thing to type.
  const linkTargets: LinkTarget[] = [
    ...appLinkTargets(visible).map((t) => ({
      group: "CampTool",
      path: t.path,
      label: t.label,
      kind: "route" as const,
    })),
    ...(await faqLinkTargets(active)).map((t) => ({
      group: "FAQ answers",
      path: t.path,
      label: t.label,
      kind: "route" as const,
    })),
  ];
  return redact(privacy, {
    id: page.id,
    slug: page.slug,
    title: page.title,
    body: page.body,
    knownSlugs: [...slugs],
    linkTargets,
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

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    }
  }, [fetcher.data]);

  const blocks = useMemo(() => parseWikiBody(body), [body]);

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

        <MarkupTextarea
          label="Body"
          value={body}
          onChange={setBody}
          targets={linkTargets}
          minRows={14}
        />

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
