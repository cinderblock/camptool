/**
 * One FAQ answer, standalone (see plans/camp-faq.md). This is what a
 * `[[/faq/how-do-i-get-a-ticket|…]]` link from a wiki page or another part of
 * CampTool resolves to, and what "Link to this answer" hands out.
 *
 * The slug is frozen at creation, so re-wording a question never breaks a link
 * someone already wrote.
 */
import {
  Anchor,
  Badge,
  Card,
  Container,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Link } from "react-router";
import { WikiBody } from "~/components/WikiBody";
import { GENERAL_CATEGORY } from "~/lib/faq";
import { getEntryBySlug, listCategories } from "~/lib/faq.server";
import { featureVisibleTo } from "~/lib/features";
import { loadFeatureStates, requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveCamp } from "~/lib/session.server";
import { parseWikiBody } from "~/lib/wiki";
import { existingSlugs } from "~/lib/wiki.server";
import type { Route } from "./+types/faq.$slug";

export function meta({ data: d }: Route.MetaArgs) {
  return [{ title: `${d?.entry?.question ?? "Answer"} · FAQ · CampTool` }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const { user: viewer, active, privacy } = await requireActiveCamp(request);
  await requireFeature(active, "faq");
  const isOfficer = hasAtLeast(active.membership.role, "officer");

  const states = await loadFeatureStates(active.camp.id);
  const wikiEnabled = featureVisibleTo(
    states.get("wiki") ?? "off",
    active.membership.role,
  );

  const row = await getEntryBySlug(active.camp.id, params.slug);
  // An unpublished answer is visible to officers and to whoever asked it —
  // everyone else sees the same "not here" as a bad link.
  const visible =
    row &&
    (row.status === "published" || isOfficer || row.askedById === viewer.id);

  const [categories, slugs] = await Promise.all([
    listCategories(active.camp.id),
    wikiEnabled
      ? existingSlugs(active.camp.id)
      : Promise.resolve(new Set<string>()),
  ]);

  return redact(privacy, {
    wikiEnabled,
    knownSlugs: [...slugs],
    entry:
      row && visible
        ? {
            question: row.question,
            answer: row.answer,
            status: row.status,
            category:
              categories.find((c) => c.id === row.categoryId)?.name ??
              GENERAL_CATEGORY,
          }
        : null,
  });
}

export default function FaqEntry({ loaderData }: Route.ComponentProps) {
  const { entry, knownSlugs, wikiEnabled } = loaderData;

  return (
    <Container size="sm">
      <Stack gap="lg">
        <Anchor component={Link} to="/faq" size="sm">
          ← All questions
        </Anchor>

        {!entry ? (
          <Card withBorder padding="lg" radius="md">
            <Text size="sm" c="dimmed">
              That answer isn't here. It may have been archived, or the link may
              be out of date — the full list is one click back.
            </Text>
          </Card>
        ) : (
          <>
            <div>
              <Group gap="xs" mb={4}>
                <Badge variant="light" color="gray">
                  {entry.category}
                </Badge>
                {entry.status !== "published" ? (
                  <Badge variant="light" color="orange">
                    {entry.status === "pending"
                      ? "Not answered yet"
                      : "Archived"}
                  </Badge>
                ) : null}
              </Group>
              <Title order={2}>{entry.question}</Title>
            </div>
            <Card withBorder padding="lg" radius="md">
              {entry.answer.trim() ? (
                <WikiBody
                  blocks={parseWikiBody(entry.answer)}
                  knownSlugs={knownSlugs}
                  wikiEnabled={wikiEnabled}
                />
              ) : (
                <Text size="sm" c="dimmed" fs="italic">
                  Waiting on an officer to answer this one.
                </Text>
              )}
            </Card>
          </>
        )}
      </Stack>
    </Container>
  );
}
