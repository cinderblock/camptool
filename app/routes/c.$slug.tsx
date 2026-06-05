import {
  Alert,
  Button,
  Container,
  Group,
  Image,
  Paper,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { and, eq } from "drizzle-orm";
import { data, useFetcher } from "react-router";
import { db } from "../../db/client.server";
import { camp, recruitApplication, user } from "../../db/schema";
import type { Route } from "./+types/c.$slug";

export function meta({ data: d }: Route.MetaArgs) {
  const name = d?.campName ?? "Camp";
  return [{ title: `Join ${name} · CampTool` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const [found] = await db
    .select({ id: camp.id, name: camp.name, logo: camp.logo })
    .from(camp)
    .where(eq(camp.slug, params.slug))
    .limit(1);
  if (!found) throw data("Camp not found", { status: 404 });
  return { campName: found.name, logo: found.logo, slug: params.slug };
}

export async function action({ request, params }: Route.ActionArgs) {
  const [found] = await db
    .select({ id: camp.id })
    .from(camp)
    .where(eq(camp.slug, params.slug))
    .limit(1);
  if (!found) throw data("Camp not found", { status: 404 });

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  const playaName = String(form.get("playaName") ?? "").trim() || null;
  const message = String(form.get("message") ?? "").trim() || null;

  if (!name) return data({ error: "Please enter your name." }, { status: 400 });
  if (!email || !email.includes("@")) {
    return data({ error: "Please enter a valid email." }, { status: 400 });
  }

  const [existing] = await db
    .select({ id: recruitApplication.id, status: recruitApplication.status })
    .from(recruitApplication)
    .where(
      and(
        eq(recruitApplication.campId, found.id),
        eq(recruitApplication.email, email),
      ),
    )
    .limit(1);
  if (existing && existing.status === "pending") {
    return data({
      ok: "You've already applied — the camp will be in touch. Hang tight!",
    });
  }

  const [matchedUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  await db.insert(recruitApplication).values({
    id: crypto.randomUUID(),
    campId: found.id,
    name,
    email,
    playaName,
    message,
    status: "pending",
    userId: matchedUser?.id ?? null,
  });

  return data({ ok: `Thanks, ${name}! Your application has been sent.` });
}

type FetcherData = { ok?: string; error?: string };

export default function PublicCamp({ loaderData }: Route.ComponentProps) {
  const { campName, logo } = loaderData;
  const fetcher = useFetcher<FetcherData>();
  const result = fetcher.data;
  const submitting = fetcher.state !== "idle";

  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <Stack gap="xs" align="center">
          {logo ? (
            <Image src={logo} alt={campName} w={96} h={96} radius="md" />
          ) : null}
          <Title order={1} ta="center">
            {campName}
          </Title>
          <Text c="dimmed" ta="center">
            Interested in joining? Tell us a bit about yourself and the camp
            will reach out.
          </Text>
        </Stack>

        <Paper withBorder radius="md" p="lg">
          {result?.ok ? (
            <Alert color="green" title="Application received">
              {result.ok}
            </Alert>
          ) : (
            <fetcher.Form method="post">
              <Stack gap="md">
                {result?.error ? (
                  <Alert color="red" title="Check your application">
                    {result.error}
                  </Alert>
                ) : null}
                <TextInput
                  name="name"
                  label="Your name"
                  placeholder="Jane Doe"
                  required
                />
                <TextInput
                  name="email"
                  type="email"
                  label="Email"
                  placeholder="jane@example.com"
                  required
                />
                <TextInput
                  name="playaName"
                  label="Playa name"
                  description="Optional — what folks call you on playa."
                  placeholder="Dusty"
                />
                <Textarea
                  name="message"
                  label="Why do you want to join?"
                  placeholder="A sentence or two about you and what you're looking for."
                  autosize
                  minRows={3}
                />
                <Group justify="flex-end">
                  <Button type="submit" loading={submitting}>
                    Apply to join
                  </Button>
                </Group>
              </Stack>
            </fetcher.Form>
          )}
        </Paper>
      </Stack>
    </Container>
  );
}
