import {
  Alert,
  Button,
  Checkbox,
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
import { and, eq, or } from "drizzle-orm";
import { useState } from "react";
import { data, useFetcher } from "react-router";
import { AuthInline } from "~/components/AuthInline";
import { discordEnabled } from "~/lib/auth.server";
import {
  getInstanceSettings,
  setSignupUnlockCookie,
} from "~/lib/instance.server";
import { getSession } from "~/lib/session.server";
import { db } from "../../db/client.server";
import { camp, membership, recruitApplication } from "../../db/schema";
import type { Route } from "./+types/c.$slug";

export function meta({ data: d }: Route.MetaArgs) {
  const name = d?.campName ?? "Camp";
  return [{ title: `Join ${name} · CampTool` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const [found] = await db
    .select({ id: camp.id, name: camp.name, logo: camp.logo })
    .from(camp)
    .where(eq(camp.slug, params.slug))
    .limit(1);
  if (!found) throw data("Camp not found", { status: 404 });

  const session = await getSession(request);
  if (!session) {
    const payload = {
      campName: found.name,
      logo: found.logo,
      slug: params.slug,
      viewer: null,
      alreadyMember: false,
      alreadyApplied: false,
      discordEnabled,
    };
    // The public apply page is a sanctioned signup entry point. Only when the
    // instance is in invite-only mode do we drop the signup-unlock cookie that
    // lets a new account be created; in open mode we set nothing so behavior is
    // unchanged.
    const { allowOpenSignups } = await getInstanceSettings();
    if (allowOpenSignups) return payload;
    return data(payload, {
      headers: { "Set-Cookie": setSignupUnlockCookie() },
    });
  }

  const [member] = await db
    .select({ id: membership.id })
    .from(membership)
    .where(
      and(
        eq(membership.userId, session.user.id),
        eq(membership.organizationId, found.id),
      ),
    )
    .limit(1);

  const [pending] = await db
    .select({ id: recruitApplication.id })
    .from(recruitApplication)
    .where(
      and(
        eq(recruitApplication.campId, found.id),
        eq(recruitApplication.status, "pending"),
        or(
          eq(recruitApplication.userId, session.user.id),
          eq(recruitApplication.email, session.user.email),
        ),
      ),
    )
    .limit(1);

  return {
    campName: found.name,
    logo: found.logo,
    slug: params.slug,
    viewer: { name: session.user.name, email: session.user.email },
    alreadyMember: Boolean(member),
    alreadyApplied: Boolean(pending),
    discordEnabled,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const session = await getSession(request);
  if (!session) {
    return data({ error: "Please sign in to apply." }, { status: 401 });
  }

  const [found] = await db
    .select({ id: camp.id })
    .from(camp)
    .where(eq(camp.slug, params.slug))
    .limit(1);
  if (!found) throw data("Camp not found", { status: 404 });

  const [member] = await db
    .select({ id: membership.id })
    .from(membership)
    .where(
      and(
        eq(membership.userId, session.user.id),
        eq(membership.organizationId, found.id),
      ),
    )
    .limit(1);
  if (member) {
    return data({ error: "You're already a member of this camp." });
  }

  const [pending] = await db
    .select({ id: recruitApplication.id })
    .from(recruitApplication)
    .where(
      and(
        eq(recruitApplication.campId, found.id),
        eq(recruitApplication.status, "pending"),
        or(
          eq(recruitApplication.userId, session.user.id),
          eq(recruitApplication.email, session.user.email),
        ),
      ),
    )
    .limit(1);
  if (pending) {
    return data({
      ok: "You've already applied — the camp will be in touch. Hang tight!",
    });
  }

  const form = await request.formData();
  const playaName = String(form.get("playaName") ?? "").trim() || null;
  const message = String(form.get("message") ?? "").trim() || null;

  await db.insert(recruitApplication).values({
    id: crypto.randomUUID(),
    campId: found.id,
    name: session.user.name,
    email: session.user.email,
    playaName,
    message,
    status: "pending",
    userId: session.user.id,
  });

  return data({ ok: `Thanks, ${session.user.name}! Your application is in.` });
}

type FetcherData = { ok?: string; error?: string };

export default function PublicCamp({ loaderData }: Route.ComponentProps) {
  const { campName, logo } = loaderData;

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
          {loaderData.viewer ? (
            <ApplySection {...loaderData} viewer={loaderData.viewer} />
          ) : (
            <AuthInline
              intro="Create an account to apply — so you can sign back in later and check on your application."
              discordEnabled={loaderData.discordEnabled}
            />
          )}
        </Paper>
      </Stack>
    </Container>
  );
}

function ApplySection({
  campName,
  viewer,
  alreadyMember,
  alreadyApplied,
}: {
  campName: string;
  viewer: { name: string; email: string };
  alreadyMember: boolean;
  alreadyApplied: boolean;
}) {
  const fetcher = useFetcher<FetcherData>();
  const result = fetcher.data;
  const submitting = fetcher.state !== "idle";
  const [beenBefore, setBeenBefore] = useState(false);

  if (alreadyMember) {
    return (
      <Alert color="green" title="You're in">
        You're already a member of {campName}.
      </Alert>
    );
  }
  if (alreadyApplied || result?.ok) {
    return (
      <Alert color="green" title="Application received">
        <Stack gap={6}>
          <Text size="sm">
            {result?.ok ?? "You've already applied — hang tight!"}
          </Text>
          <Text size="sm">
            The camp will reach out at <b>{viewer.email}</b>. You can revisit
            this page any time to check where things stand.
          </Text>
        </Stack>
      </Alert>
    );
  }

  return (
    <fetcher.Form method="post">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Applying as <b>{viewer.name}</b> ({viewer.email}).
        </Text>
        {result?.error ? (
          <Alert color="red" title="Check your application">
            {result.error}
          </Alert>
        ) : null}
        {/* "Playa name" is Burning Man jargon — meaningless to first-timers, so
            only ask once they say they've been. (Event-layer copy; revisit when
            the event theming layer peels out.) */}
        <Checkbox
          label="I've been to Burning Man before"
          description="No worries if not — first-timers are welcome."
          checked={beenBefore}
          onChange={(e) => setBeenBefore(e.currentTarget.checked)}
        />
        {beenBefore ? (
          <TextInput
            name="playaName"
            label="Playa name"
            description="Optional — the nickname you go by at the event."
            placeholder="Dusty"
          />
        ) : null}
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
  );
}
